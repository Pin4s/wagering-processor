import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import config from '../../src/mikro-orm.config';
import { newId } from '../../src/shared/new-id';
import { WagerTransactionsConsumer } from '../../src/modules/messaging/application/wager-transactions-consumer';
import { InboxMessageEntity } from '../../src/modules/messaging/infrastructure/inbox-message.entity';
import { OutboxMessageEntity } from '../../src/modules/messaging/infrastructure/outbox-message.entity';
import { SqsQueuesService } from '../../src/modules/messaging/infrastructure/sqs-queues.service';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionEntity } from '../../src/modules/wagering/infrastructure/wager-transaction.entity';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/create-wallet.use-case';
import { LedgerDirection } from '../../src/modules/wallet/domain/wallet-ledger-entry';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/wallet/infrastructure/wallet-ledger-entry.entity';
import { balanceFromLedger, truncateAll } from './helpers';

let orm: MikroORM;
let client: SQSClient;
let queues: SqsQueuesService;
let consumer: WagerTransactionsConsumer;
let createWallet: CreateWalletUseCase;
let mainQueue: string;
let dlq: string;
const previousEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const name of ['SQS_CONSUMER_ENABLED', 'CONSUMER_RETRY_BASE_SECONDS']) {
    previousEnv.set(name, process.env[name]);
  }
  process.env.SQS_CONSUMER_ENABLED = 'false';
  process.env.CONSUMER_RETRY_BASE_SECONDS = '0';
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  client = new SQSClient({ region: process.env.AWS_REGION, endpoint: process.env.SQS_ENDPOINT });
  queues = new SqsQueuesService(client);
  mainQueue = await queues.getTransactionsQueueUrl();
  dlq = await queues.getTransactionsDlqUrl();
  createWallet = new CreateWalletUseCase(orm.em);
});

afterAll(async () => {
  await Promise.all([drain(mainQueue), drain(dlq)]);
  client.destroy();
  await orm.close();
  for (const [name, value] of previousEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

beforeEach(async () => {
  process.env.SQS_CONSUMER_ENABLED = 'false';
  await truncateAll(orm);
  await Promise.all([drain(mainQueue), drain(dlq)]);
  consumer = new WagerTransactionsConsumer(client, queues, new ProcessWagerTransactionUseCase(orm.em));
});

afterEach(async () => {
  await consumer.onApplicationShutdown();
});

async function drain(queueUrl: string): Promise<Message[]> {
  const messages: Message[] = [];
  while (true) {
    const response = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0,
      MessageSystemAttributeNames: ['All'],
    }));
    const batch = response.Messages ?? [];
    if (batch.length === 0) {
      return messages;
    }
    for (const message of batch) {
      if (!message.ReceiptHandle) {
        throw new Error('SQS must provide a receipt handle');
      }
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      messages.push(message);
    }
  }
}

async function receiveOne(): Promise<Message> {
  const response = await client.send(new ReceiveMessageCommand({
    QueueUrl: mainQueue,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 1,
    MessageSystemAttributeNames: ['All'],
  }));
  const message = response.Messages?.[0];
  if (!message?.ReceiptHandle) {
    throw new Error('SQS must return the requested message');
  }
  return message;
}

async function send(body: string, groupId: string): Promise<string> {
  const response = await client.send(new SendMessageCommand({
    QueueUrl: mainQueue,
    MessageBody: body,
    MessageGroupId: groupId,
    MessageDeduplicationId: newId(),
  }));
  if (!response.MessageId) {
    throw new Error('SQS must return the message ID');
  }
  return response.MessageId;
}

async function openWallet(amount = '100.00') {
  return createWallet.execute({ playerId: newId(), initialBalance: { amount, currency: 'BRL' } });
}

function envelope(wallet: { id: string; playerId: string }) {
  const externalTransactionId = newId();
  return {
    messageId: newId(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'sqs-provider',
      externalTransactionId,
      idempotencyKey: `sqs-provider:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    },
  };
}

async function assertLedger(walletId: string): Promise<void> {
  const em = orm.em.fork();
  const wallet = await em.findOneOrFail(WalletEntity, walletId);
  const entries = await em.find(WalletLedgerEntryEntity, { walletId });
  expect(wallet.balanceCents).toBe(balanceFromLedger(entries));
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error('Timed out waiting for the real infrastructure state');
}

test('a valid BET is committed with its inbox row before the SQS message is acknowledged', async () => {
  const wallet = await openWallet();
  const event = envelope(wallet);
  await send(JSON.stringify(event), wallet.id);

  expect(await consumer.pollOnce()).toBe(1);

  const em = orm.em.fork();
  const transaction = await em.findOneOrFail(WagerTransactionEntity, { idempotencyKey: event.data.idempotencyKey });
  expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  const inbox = await em.find(InboxMessageEntity, {});
  expect(inbox).toHaveLength(1);
  expect(inbox[0]!.messageId).toBe(event.messageId);
  expect(inbox[0]!.processedAt).toBeInstanceOf(Date);
  const events = await em.find(OutboxMessageEntity, { aggregateId: transaction.id });
  expect(events).toHaveLength(1);
  expect(events[0]!.payload.causationId).toBe(event.messageId);
  expect(events[0]!.payload.correlationId).toBe(event.messageId);
  expect(await drain(mainQueue)).toHaveLength(0);
  await assertLedger(wallet.id);
});

test('worker killed after commit and before ack is deduplicated on redelivery', async () => {
  const wallet = await openWallet();
  const event = envelope(wallet);
  await send(JSON.stringify(event), wallet.id);
  const message = await receiveOne();

  expect(await consumer.handle(message)).toBe('ack');
  expect(await orm.em.fork().count(InboxMessageEntity, {})).toBe(1);
  await client.send(new ChangeMessageVisibilityCommand({
    QueueUrl: mainQueue, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0,
  }));

  expect(await consumer.pollOnce()).toBe(1);

  const em = orm.em.fork();
  expect(await em.count(InboxMessageEntity, {})).toBe(1);
  expect(await em.count(WalletLedgerEntryEntity, { direction: LedgerDirection.Debit })).toBe(1);
  expect(await em.count(OutboxMessageEntity, {})).toBe(4);
  expect(await drain(mainQueue)).toHaveLength(0);
  await assertLedger(wallet.id);
});

test('two broker messages with the same envelope message ID debit once and are both deleted', async () => {
  const wallet = await openWallet();
  const event = envelope(wallet);
  await send(JSON.stringify(event), wallet.id);
  await send(JSON.stringify(event), wallet.id);

  expect(await consumer.pollOnce()).toBe(2);

  const em = orm.em.fork();
  expect(await em.count(InboxMessageEntity, {})).toBe(1);
  expect(await em.count(WalletLedgerEntryEntity, { direction: LedgerDirection.Debit })).toBe(1);
  expect(await drain(mainQueue)).toHaveLength(0);
  await assertLedger(wallet.id);
});

test('invalid JSON is sent unchanged to the DLQ before deletion from the main queue', async () => {
  const body = '{invalid json';
  const sqsId = await send(body, 'invalid-group');

  expect(await consumer.pollOnce()).toBe(1);

  const messages = await drain(dlq);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.Body).toBe(body);
  expect(messages[0]!.Attributes?.MessageGroupId).toBe('invalid-group');
  expect(messages[0]!.Attributes?.MessageDeduplicationId).toBe(sqsId);
  expect(await drain(mainQueue)).toHaveLength(0);
  const em = orm.em.fork();
  expect(await em.count(InboxMessageEntity, {})).toBe(0);
  expect(await em.count(WagerTransactionEntity, {})).toBe(0);
  expect(await em.count(WalletLedgerEntryEntity, {})).toBe(0);
  expect(await em.count(OutboxMessageEntity, {})).toBe(0);
});

test('a real closed PostgreSQL connection retries five times and SQS redrives the message', async () => {
  const wallet = await openWallet();
  const event = envelope(wallet);
  const closedOrm = await MikroORM.init(config);
  await closedOrm.em.getConnection().execute('select 1');
  const closedClient = closedOrm.em.getConnection().getClient();
  await closedOrm.close();
  closedOrm.config.set('driverOptions', closedClient);
  const failingConsumer = new WagerTransactionsConsumer(client, queues, new ProcessWagerTransactionUseCase(closedOrm.em));
  await send(JSON.stringify(event), wallet.id);

  for (let count = 1; count <= 5; count++) {
    expect(await failingConsumer.pollOnce()).toBe(1);
    const attributes = await client.send(new GetQueueAttributesCommand({
      QueueUrl: mainQueue, AttributeNames: ['ApproximateNumberOfMessages'],
    }));
    expect(Number(attributes.Attributes?.ApproximateNumberOfMessages)).toBe(1);
    expect(await orm.em.fork().count(InboxMessageEntity, {})).toBe(0);
  }
  expect(await failingConsumer.pollOnce()).toBe(0);

  const messages = await drain(dlq);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.Body).toBe(JSON.stringify(event));
  expect(await drain(mainQueue)).toHaveLength(0);
  expect(await orm.em.fork().count(WagerTransactionEntity, { kind: WagerTransactionKind.Bet })).toBe(0);
  await failingConsumer.onApplicationShutdown();
  await closedOrm.close();
}, 20_000);

test('a rejected BET is persisted and acknowledged', async () => {
  const wallet = await openWallet('0.00');
  const event = envelope(wallet);
  await send(JSON.stringify(event), wallet.id);

  expect(await consumer.pollOnce()).toBe(1);

  const em = orm.em.fork();
  const transaction = await em.findOneOrFail(WagerTransactionEntity, { idempotencyKey: event.data.idempotencyKey });
  expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
  expect(await em.count(InboxMessageEntity, {})).toBe(1);
  expect(await drain(mainQueue)).toHaveLength(0);
  expect(await drain(dlq)).toHaveLength(0);
  await assertLedger(wallet.id);
});

test('shutdown completes the active message and immediately releases the rest of the batch', async () => {
  const wallet = await openWallet();
  const events = Array.from({ length: 6 }, () => envelope(wallet));
  const locker = orm.em.fork();
  await locker.begin();
  let shutdown: Promise<void> | undefined;
  try {
    await locker.findOneOrFail(WalletEntity, wallet.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
    for (const event of events) {
      await send(JSON.stringify(event), wallet.id);
    }
    process.env.SQS_CONSUMER_ENABLED = 'true';
    consumer.onApplicationBootstrap();
    await waitUntil(async () => {
      const waiting = await orm.em.getConnection().execute<{ count: string }[]>(
        "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%wallets%'",
      );
      const attributes = await client.send(new GetQueueAttributesCommand({
        QueueUrl: mainQueue, AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
      }));
      return Number(waiting[0]?.count) > 0 && Number(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible) === events.length;
    });
    let finished = false;
    shutdown = consumer.onApplicationShutdown().then(() => { finished = true; });
    await Bun.sleep(50);
    expect(finished).toBe(false);

    await locker.commit();
    await shutdown;

    const em = orm.em.fork();
    expect(await em.count(InboxMessageEntity, {})).toBe(1);
    expect(await em.count(WagerTransactionEntity, { kind: WagerTransactionKind.Bet })).toBe(1);
    expect(await em.count(WalletLedgerEntryEntity, { direction: LedgerDirection.Debit })).toBe(1);
    const remaining = await drain(mainQueue);
    expect(remaining).toHaveLength(5);
    const visibleIds = remaining.map((message) => {
      const body: { messageId: string } = JSON.parse(message.Body ?? 'null');
      return body.messageId;
    });
    const processed = await em.find(InboxMessageEntity, {});
    expect([...visibleIds, ...processed.map((message) => message.messageId)].sort()).toEqual(events.map((event) => event.messageId).sort());
    expect(await drain(dlq)).toHaveLength(0);
    await assertLedger(wallet.id);
  } finally {
    if (locker.isInTransaction()) {
      await locker.rollback();
    }
    await consumer.onApplicationShutdown();
    await shutdown;
  }
}, 15_000);

interface InvalidEnvelopeCase {
  name: string;
  make: (event: ReturnType<typeof envelope>) => unknown;
}

const invalidEnvelopes: InvalidEnvelopeCase[] = [
  { name: 'unsupported type', make: (event) => ({ ...event, type: 'OtherEvent' }) },
  { name: 'missing message ID', make: (event) => { const { messageId, ...rest } = event; return rest; } },
  { name: 'invalid wallet ID', make: (event) => ({ ...event, data: { ...event.data, walletId: 'invalid' } }) },
  { name: 'missing idempotency key', make: (event) => { const { idempotencyKey, ...data } = event.data; return { ...event, data }; } },
  { name: 'invalid money precision', make: (event) => ({ ...event, data: { ...event.data, money: { amount: '1.999', currency: 'BRL' } } }) },
  { name: 'missing reversal reference', make: (event) => ({ ...event, data: { ...event.data, kind: WagerTransactionKind.Refund } }) },
];

test.each(invalidEnvelopes)('$name is a permanent failure sent to the DLQ', async ({ make }) => {
  const wallet = await openWallet();
  const body = JSON.stringify(make(envelope(wallet)));
  await send(body, wallet.id);

  expect(await consumer.pollOnce()).toBe(1);

  expect(await drain(mainQueue)).toHaveLength(0);
  const messages = await drain(dlq);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.Body).toBe(body);
  const em = orm.em.fork();
  expect(await em.count(InboxMessageEntity, {})).toBe(0);
  expect(await em.count(WagerTransactionEntity, { kind: WagerTransactionKind.Bet })).toBe(0);
  expect(await em.count(WalletLedgerEntryEntity, { direction: LedgerDirection.Debit })).toBe(0);
  await assertLedger(wallet.id);
});

test.each(['missing wallet', 'wallet mismatch', 'idempotency conflict'])('%s is terminal and acknowledged', async (scenario) => {
  const wallet = await openWallet();
  const event = envelope(wallet);
  if (scenario === 'missing wallet') {
    event.data.walletId = newId();
  } else if (scenario === 'wallet mismatch') {
    event.data.playerId = newId();
  } else {
    await send(JSON.stringify(event), wallet.id);
    expect(await consumer.pollOnce()).toBe(1);
    event.messageId = newId();
    event.data.money.amount = '20.00';
  }
  await send(JSON.stringify(event), wallet.id);

  expect(await consumer.pollOnce()).toBe(1);

  expect(await drain(mainQueue)).toHaveLength(0);
  expect(await drain(dlq)).toHaveLength(0);
  await assertLedger(wallet.id);
});

test('a pending reference is a persisted result and is acknowledged', async () => {
  const wallet = await openWallet();
  const event = envelope(wallet);
  const pending = {
    ...event,
    data: { ...event.data, kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'missing-bet' },
  };
  await send(JSON.stringify(pending), wallet.id);

  expect(await consumer.pollOnce()).toBe(1);

  const transaction = await orm.em.fork().findOneOrFail(WagerTransactionEntity, { idempotencyKey: event.data.idempotencyKey });
  expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
  expect(await drain(mainQueue)).toHaveLength(0);
  expect(await drain(dlq)).toHaveLength(0);
});

test('shutdown aborts an empty long poll promptly', async () => {
  process.env.SQS_CONSUMER_ENABLED = 'true';
  consumer.onApplicationBootstrap();
  await Bun.sleep(100);
  const started = Date.now();

  await consumer.onApplicationShutdown();

  expect(Date.now() - started).toBeLessThan(1_000);
});
