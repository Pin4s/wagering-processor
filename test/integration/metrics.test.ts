import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import config from '../../src/mikro-orm.config';
import { newId } from '../../src/shared/new-id';
import { MetricsController } from '../../src/shared/metrics/metrics.controller';
import { MetricsRegistry } from '../../src/shared/metrics/metrics.registry';
import { OutboxPublisher } from '../../src/modules/messaging/application/outbox-publisher';
import { WagerTransactionsConsumer } from '../../src/modules/messaging/application/wager-transactions-consumer';
import { OutboxMessageEntity } from '../../src/modules/messaging/infrastructure/outbox-message.entity';
import { SqsQueuesService } from '../../src/modules/messaging/infrastructure/sqs-queues.service';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/create-wallet.use-case';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/wallet.entity';
import { truncateAll } from './helpers';

let app: INestApplication;
let orm: MikroORM;
let client: SQSClient;
let queues: SqsQueuesService;
let registry: MetricsRegistry;
let baseUrl: string;
let mainQueue: string;
let dlq: string;
const previousEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const name of ['OUTBOX_PUBLISHER_ENABLED', 'SQS_CONSUMER_ENABLED', 'CONSUMER_RETRY_BASE_SECONDS']) {
    previousEnv.set(name, process.env[name]);
  }
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  process.env.SQS_CONSUMER_ENABLED = 'false';
  process.env.CONSUMER_RETRY_BASE_SECONDS = '0';
  app = await NestFactory.create(AppModule, { logger: false });
  orm = app.get(MikroORM);
  await orm.migrator.up();
  client = app.get(SQSClient);
  queues = app.get(SqsQueuesService);
  registry = app.get(MetricsRegistry);
  mainQueue = await queues.getTransactionsQueueUrl();
  dlq = await queues.getTransactionsDlqUrl();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await Promise.all([emptyQueue(mainQueue), emptyQueue(dlq)]);
  await app.close();
  for (const [name, value] of previousEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

beforeEach(async () => {
  await truncateAll(orm);
  await Promise.all([emptyQueue(mainQueue), emptyQueue(dlq)]);
});

async function emptyQueue(queueUrl: string): Promise<void> {
  while (true) {
    const response = await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }));
    const messages = response.Messages ?? [];
    if (messages.length === 0) {
      return;
    }
    for (const message of messages) {
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
}

async function scrape(): Promise<string> {
  const response = await fetch(`${baseUrl}/metrics`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain; version=0.0.4');
  return response.text();
}

function sample(text: string, series: string): number {
  const line = text.split('\n').find((line) => line.startsWith(series + ' '));
  if (!line) {
    throw new Error(`Missing metric series: ${series}`);
  }
  return Number(line.slice(series.length + 1));
}

async function openWallet() {
  return app.get(CreateWalletUseCase).execute({ playerId: newId(), initialBalance: { amount: '100.00', currency: 'BRL' } });
}

function bet(wallet: { id: string; playerId: string }) {
  const externalTransactionId = newId();
  return {
    providerId: 'metrics-provider', externalTransactionId, idempotencyKey: `metrics:${externalTransactionId}`,
    walletId: wallet.id, playerId: wallet.playerId, roundId: 'round-1', gameId: 'game-1',
    kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' },
  };
}

async function sendRequest(input: ReturnType<typeof bet>, messageId: string): Promise<void> {
  await client.send(new SendMessageCommand({
    QueueUrl: mainQueue,
    MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: input }),
    MessageGroupId: input.walletId,
    MessageDeduplicationId: newId(),
  }));
}

test('HTTP BET and replay expose shared counters, durations and an unauthenticated metrics endpoint', async () => {
  const wallet = await openWallet();
  const input = bet(wallet);
  const submit = () => fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
    body: JSON.stringify(input),
  });

  expect((await submit()).status).toBe(200);
  const first = await scrape();
  expect(first).toContain('wager_transactions_total{status="PROCESSED",kind="BET",source="http"} 1\n');
  expect(sample(first, 'wager_processing_duration_seconds_count')).toBe(1);
  expect(sample(first, 'wallet_lock_wait_seconds_count')).toBe(1);

  const replay = await submit();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ idempotentReplay: true });
  const second = await scrape();
  expect(second).toContain('wager_transactions_total{status="PROCESSED",kind="BET",source="http"} 1\n');
  expect(second).toContain('duplicates_detected_total{layer="idempotency"} 1\n');
  expect(sample(second, 'wager_processing_duration_seconds_count')).toBe(2);
  expect(sample(second, 'wallet_lock_wait_seconds_count')).toBe(2);
  expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
  expect((await fetch(`${baseUrl}/wallets/${wallet.id}`)).status).toBe(200);
  expect(second).not.toContain(wallet.id);
  expect(second).not.toContain(input.externalTransactionId);
});

test('outbox gauges query pending rows and their oldest age again on every scrape', async () => {
  await openWallet();
  await orm.em.getConnection().execute("update outbox_messages set occurred_at = clock_timestamp() - interval '2 seconds', next_attempt_at = clock_timestamp() + interval '1 hour'");

  const pending = await scrape();

  expect(sample(pending, 'outbox_pending')).toBe(2);
  expect(sample(pending, 'outbox_lag_seconds')).toBeGreaterThan(0);
  await orm.em.fork().nativeUpdate(OutboxMessageEntity, {}, { publishedAt: new Date() });
  const published = await scrape();
  expect(sample(published, 'outbox_pending')).toBe(0);
  expect(sample(published, 'outbox_lag_seconds')).toBe(0);
});

test('only a divergent reconciliation increments its counter', async () => {
  const wallet = await openWallet();
  const reconcile = () => fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
  expect((await reconcile()).status).toBe(200);
  expect(sample(await scrape(), 'reconciliation_divergences_total')).toBe(0);
  await orm.em.getConnection().execute('update wallets set balance_cents = balance_cents + 100 where id = ?', [wallet.id]);

  const response = await reconcile();

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ consistent: false });
  expect(sample(await scrape(), 'reconciliation_divergences_total')).toBe(1);
});

test('DLQ gauge reads the real SQS message count at scrape time', async () => {
  expect(sample(await scrape(), 'sqs_dlq_messages')).toBe(0);
  await client.send(new SendMessageCommand({
    QueueUrl: dlq, MessageBody: '{}', MessageGroupId: 'metrics', MessageDeduplicationId: newId(),
  }));

  expect(sample(await scrape(), 'sqs_dlq_messages')).toBe(1);

  await emptyQueue(dlq);
  expect(sample(await scrape(), 'sqs_dlq_messages')).toBe(0);
});

test('an unavailable SQS queue omits the DLQ metric instead of exposing a stale value', async () => {
  expect(await scrape()).toContain('sqs_dlq_messages');
  const previousName = process.env.SQS_WAGER_TRANSACTIONS_DLQ;
  let missingQueues: SqsQueuesService;
  try {
    process.env.SQS_WAGER_TRANSACTIONS_DLQ = `missing-${newId()}.fifo`;
    missingQueues = new SqsQueuesService(client);
  } finally {
    if (previousName === undefined) {
      delete process.env.SQS_WAGER_TRANSACTIONS_DLQ;
    } else {
      process.env.SQS_WAGER_TRANSACTIONS_DLQ = previousName;
    }
  }
  const controller = new MetricsController(registry, orm.em, client, missingQueues);

  const text = await controller.get();

  expect(text).not.toContain('sqs_dlq_messages');
  expect(text).toContain('outbox_pending 0\n');
});

test('SQS decisions and inbox duplicates use the same registry and retain the SQS source label', async () => {
  const input = bet(await openWallet());
  const messageId = newId();
  await sendRequest(input, messageId);
  const consumer = app.get(WagerTransactionsConsumer);
  expect(await consumer.pollOnce()).toBe(1);
  const first = await scrape();
  expect(first).toContain('wager_transactions_total{status="PROCESSED",kind="BET",source="sqs"} 1\n');
  expect(first).toContain('consumer_messages_total{decision="ack"} 1\n');

  await sendRequest(input, messageId);
  expect(await consumer.pollOnce()).toBe(1);

  const replay = await scrape();
  expect(replay).toContain('duplicates_detected_total{layer="inbox"} 1\n');
  expect(replay).toContain('consumer_messages_total{decision="ack"} 2\n');
});

test('a real SQS publication failure increments the outbox failure counter once', async () => {
  await openWallet();
  const missing = new URL(await queues.getEventsQueueUrl());
  missing.pathname = missing.pathname.replace(/[^/]+$/, `missing-${newId()}.fifo`);
  const publisher = new OutboxPublisher(orm.em, client, queues, missing.toString(), registry);

  expect(await publisher.publishBatch()).toEqual([]);

  expect(sample(await scrape(), 'outbox_publish_failures_total')).toBe(2);
});

test('a real closed SQL client increments retry metrics when the consumer decides to retry', async () => {
  const input = bet(await openWallet());
  const closedOrm = await MikroORM.init(config);
  await closedOrm.em.getConnection().execute('select 1');
  const closedClient = closedOrm.em.getConnection().getClient();
  await closedOrm.close();
  closedOrm.config.set('driverOptions', closedClient);
  const failing = new WagerTransactionsConsumer(client, queues, new ProcessWagerTransactionUseCase(closedOrm.em, registry), registry);
  try {
    await sendRequest(input, newId());

    expect(await failing.pollOnce()).toBe(1);

    const text = await scrape();
    expect(text).toContain('consumer_messages_total{decision="retry"} 1\n');
    expect(sample(text, 'consumer_retries_total')).toBe(1);
  } finally {
    await failing.onApplicationShutdown();
    await closedOrm.close();
  }
});

test('a real wallet lock timeout increments the lock timeout metric', async () => {
  const wallet = await openWallet();
  const locker = orm.em.fork();
  await locker.begin();
  try {
    await locker.findOneOrFail(WalletEntity, wallet.id, { lockMode: LockMode.PESSIMISTIC_WRITE });

    await expect(orm.em.fork().transactional(async (em) => {
      await em.execute("set local lock_timeout = '50ms'");
      await new ProcessWagerTransactionUseCase(em, registry).execute(bet(wallet));
    })).rejects.toMatchObject({ code: '55P03' });

    expect(await scrape()).toContain('lock_errors_total{type="lock_timeout"} 1\n');
  } finally {
    await locker.rollback();
  }
});
