import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient, type Message } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config';
import { newId } from '../../src/shared/new-id';
import { OutboxPublisher } from '../../src/modules/messaging/application/outbox-publisher';
import { OutboxMessageEntity } from '../../src/modules/messaging/infrastructure/outbox-message.entity';
import { SqsQueuesService } from '../../src/modules/messaging/infrastructure/sqs-queues.service';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/create-wallet.use-case';
import { truncateAll } from './helpers';

let orm: MikroORM;
let client: SQSClient;
let queues: SqsQueuesService;
let publisher: OutboxPublisher;
let createWallet: CreateWalletUseCase;
let processTransaction: ProcessWagerTransactionUseCase;
let queueUrl: string;
let previousPublisherEnabled: string | undefined;

beforeAll(async () => {
  previousPublisherEnabled = process.env.OUTBOX_PUBLISHER_ENABLED;
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  client = new SQSClient({ region: process.env.AWS_REGION, endpoint: process.env.SQS_ENDPOINT });
  queues = new SqsQueuesService(client);
  queueUrl = await queues.getEventsQueueUrl();
  createWallet = new CreateWalletUseCase(orm.em);
  processTransaction = new ProcessWagerTransactionUseCase(orm.em);
});

afterAll(async () => {
  await publisher.onApplicationShutdown();
  await receiveAndDeleteAll();
  client.destroy();
  await orm.close();
  if (previousPublisherEnabled === undefined) {
    delete process.env.OUTBOX_PUBLISHER_ENABLED;
  } else {
    process.env.OUTBOX_PUBLISHER_ENABLED = previousPublisherEnabled;
  }
});

beforeEach(async () => {
  await truncateAll(orm);
  await receiveAndDeleteAll();
  publisher = new OutboxPublisher(orm.em, client, queues);
});

async function receiveAndDeleteAll(): Promise<Message[]> {
  const collected: Message[] = [];
  while (true) {
    const response = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
    }));
    const messages = response.Messages ?? [];
    if (messages.length === 0) {
      return collected;
    }
    for (const message of messages) {
      if (!message.ReceiptHandle) {
        throw new Error('SQS must return a receipt handle');
      }
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      collected.push(message);
    }
  }
}

function request(wallet: { id: string; playerId: string }, kind: WagerTransactionKind) {
  const externalTransactionId = newId();
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount: '10.00', currency: 'BRL' },
  };
}

async function prepareFundedWallets(count: number) {
  const wallets = await Promise.all(Array.from({ length: count }, () => createWallet.execute({
    playerId: newId(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  })));
  while ((await publisher.publishBatch()).length > 0) {}
  await receiveAndDeleteAll();
  return wallets;
}

async function pendingRows() {
  return orm.em.fork().find(OutboxMessageEntity, { publishedAt: null }, { orderBy: { occurredAt: 'asc' } });
}

async function enqueueOneEvent(): Promise<string> {
  const wallet = await createWallet.execute({
    playerId: newId(),
    initialBalance: { amount: '0.00', currency: 'BRL' },
  });
  const result = await processTransaction.execute(request(wallet, WagerTransactionKind.Loss));
  const row = await orm.em.fork().findOneOrFail(OutboxMessageEntity, { aggregateId: result.transactionId });
  return row.id;
}

test('committed then crashed before publishing', async () => {
  publisher.onApplicationBootstrap();
  const wallets = await prepareFundedWallets(1);
  const result = await processTransaction.execute(request(wallets[0]!, WagerTransactionKind.Bet));
  const pending = await pendingRows();
  expect(pending).toHaveLength(2);
  for (const row of pending) {
    expect(row.payload.data).toMatchObject({ transactionId: result.transactionId });
    expect(row.attempts).toBe(0);
  }

  const publishedIds = await publisher.publishBatch();

  expect(publishedIds.sort()).toEqual(pending.map((row) => row.id).sort());
  expect(await pendingRows()).toHaveLength(0);
  const stored = await orm.em.fork().find(OutboxMessageEntity, { id: { $in: publishedIds } });
  for (const row of stored) {
    expect(row.publishedAt).toBeInstanceOf(Date);
  }
  const messages = await receiveAndDeleteAll();
  expect(messages).toHaveLength(2);
  const receivedIds: string[] = [];
  for (const message of messages) {
    if (!message.Body) {
      throw new Error('SQS must return the event body');
    }
    const body: { eventId: string; eventType: string } = JSON.parse(message.Body);
    const expected = pending.find((row) => row.id === body.eventId);
    if (!expected) {
      throw new Error('SQS returned an unexpected event');
    }
    receivedIds.push(body.eventId);
    expect(body.eventType).toBe(expected.eventType);
    expect(JSON.parse(message.Body)).toEqual(expected.payload);
    expect(message.Attributes?.MessageGroupId).toBe(expected.aggregateId);
    expect(message.Attributes?.MessageDeduplicationId).toBe(body.eventId);
  }
  expect(receivedIds.sort()).toEqual(publishedIds.sort());
}, 15_000);

test('two publishers on the same outbox', async () => {
  const wallets = await prepareFundedWallets(10);
  await Promise.all(wallets.map((wallet) => processTransaction.execute(request(wallet, WagerTransactionKind.Bet))));
  const pending = await pendingRows();
  expect(pending).toHaveLength(20);
  const secondPublisher = new OutboxPublisher(orm.em, client, queues);
  const firstIds: string[] = [];
  const secondIds: string[] = [];

  let rounds = 0;
  while ((await pendingRows()).length > 0) {
    const [firstBatch, secondBatch] = await Promise.all([publisher.publishBatch(), secondPublisher.publishBatch()]);
    expect(firstBatch.length).toBeLessThanOrEqual(10);
    expect(secondBatch.length).toBeLessThanOrEqual(10);
    firstIds.push(...firstBatch);
    secondIds.push(...secondBatch);
    rounds++;
    expect(rounds).toBeLessThanOrEqual(5);
  }

  expect(firstIds.length).toBeGreaterThan(0);
  expect(secondIds.length).toBeGreaterThan(0);
  const secondSet = new Set(secondIds);
  expect(firstIds.filter((id) => secondSet.has(id))).toEqual([]);
  const allIds = [...firstIds, ...secondIds];
  expect(new Set(allIds).size).toBe(20);
  expect(allIds.sort()).toEqual(pending.map((row) => row.id).sort());
  expect(await pendingRows()).toHaveLength(0);
  const messages = await receiveAndDeleteAll();
  expect(messages).toHaveLength(20);
}, 15_000);

test('SQS failure schedules a retry', async () => {
  const eventId = await enqueueOneEvent();
  const missingQueue = new URL(queueUrl);
  missingQueue.pathname = missingQueue.pathname.replace(/[^/]+$/, `missing-${newId()}.fifo`);
  const failingPublisher = new OutboxPublisher(orm.em, client, queues, missingQueue.toString());

  expect(await failingPublisher.publishBatch()).toEqual([]);

  const row = await orm.em.fork().findOneOrFail(OutboxMessageEntity, eventId);
  expect(row.publishedAt).toBeNull();
  expect(row.attempts).toBe(1);
  expect(row.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());
  expect(await failingPublisher.publishBatch()).toEqual([]);
  const after = await orm.em.fork().findOneOrFail(OutboxMessageEntity, eventId);
  expect(after.attempts).toBe(1);
  expect(after.nextAttemptAt).toEqual(row.nextAttemptAt);
});

test('published messages are not published again', async () => {
  const eventId = await enqueueOneEvent();

  expect(await publisher.publishBatch()).toEqual([eventId]);
  expect(await publisher.publishBatch()).toEqual([]);
  expect(await receiveAndDeleteAll()).toHaveLength(1);
});

test('shutdown waits for the active batch and the same instance does not overlap batches', async () => {
  const eventId = await enqueueOneEvent();
  const locker = orm.em.fork();
  await locker.begin();
  let batch: Promise<string[]> | undefined;
  let shutdown: Promise<void> | undefined;
  try {
    await locker.execute('lock table outbox_messages in access exclusive mode');
    batch = publisher.publishBatch();
    await Bun.sleep(50);
    expect(await publisher.publishBatch()).toEqual([]);
    let finished = false;
    shutdown = publisher.onApplicationShutdown().then(() => { finished = true; });
    await Bun.sleep(50);
    expect(finished).toBe(false);

    await locker.commit();

    expect(await batch).toEqual([eventId]);
    await shutdown;
    expect(finished).toBe(true);
    expect(await pendingRows()).toHaveLength(0);
  } finally {
    if (locker.isInTransaction()) {
      await locker.rollback();
    }
    await batch;
    await shutdown;
  }
});
