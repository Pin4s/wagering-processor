import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config';
import { newId } from '../../src/shared/new-id';
import { InboxMessageEntity } from '../../src/modules/messaging/infrastructure/inbox-message.entity';
import { OutboxMessageEntity } from '../../src/modules/messaging/infrastructure/outbox-message.entity';
import { SqsQueuesService } from '../../src/modules/messaging/infrastructure/sqs-queues.service';
import { WAGER_TRANSACTIONS_CONSUMER_NAME } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionEntity } from '../../src/modules/wagering/infrastructure/wager-transaction.entity';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/create-wallet.use-case';
import { LedgerDirection } from '../../src/modules/wallet/domain/wallet-ledger-entry';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/wallet/infrastructure/wallet-ledger-entry.entity';
import { balanceFromLedger, truncateAll } from '../integration/helpers';

interface AppProcess {
  child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  port: number;
  committedTransactions: Set<string>;
  acknowledgedMessages: number;
  publishedEvents: number;
  outputLines: number;
  drains: Promise<void>[];
}

interface DatabaseState {
  bets: number;
  pending_outbox: number;
  pending_reference: number;
  inbox: number;
  balance: string;
}

interface QueueState {
  visible: number;
  inFlight: number;
  delayed: number;
}

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const applications: AppProcess[] = [];
let closing = false;
let orm: MikroORM;
let client: SQSClient;
let transactionsQueue: string;
let dlq: string;
let eventsQueue: string;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  client = new SQSClient({ region: process.env.AWS_REGION, endpoint: process.env.SQS_ENDPOINT });
  const queues = new SqsQueuesService(client);
  [transactionsQueue, dlq, eventsQueue] = await Promise.all([
    queues.getTransactionsQueueUrl(), queues.getTransactionsDlqUrl(), queues.getEventsQueueUrl(),
  ]);
  await truncateAll(orm);
  await Promise.all([emptyQueue(transactionsQueue), emptyQueue(dlq), emptyQueue(eventsQueue)]);
}, 60_000);

afterAll(async () => {
  await stopApplications();
  try {
    if (client && transactionsQueue && dlq && eventsQueue) {
      await Promise.all([emptyQueue(transactionsQueue), emptyQueue(dlq), emptyQueue(eventsQueue)]);
    }
  } finally {
    client?.destroy();
    await orm?.close();
  }
}, 60_000);

async function emptyQueue(queueUrl: string): Promise<void> {
  await waitUntil('queue cleanup', async () => {
    const response = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 1,
    }), { abortSignal: AbortSignal.timeout(3_000) });
    const messages = response.Messages ?? [];
    if (messages.length > 0) {
      const deleted = await client.send(new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle })),
      }), { abortSignal: AbortSignal.timeout(3_000) });
      if (deleted.Failed?.length) {
        throw new Error('SQS queue cleanup failed');
      }
    }
    const state = await queueState(queueUrl);
    return state.visible + state.inFlight + state.delayed === 0;
  }, 45_000);
}

async function queueState(queueUrl: string): Promise<QueueState> {
  const response = await client.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
  }), { abortSignal: AbortSignal.timeout(3_000) });
  const attributes = response.Attributes;
  if (!attributes) {
    throw new Error('SQS did not return queue attributes');
  }
  const state = {
    visible: Number(attributes.ApproximateNumberOfMessages),
    inFlight: Number(attributes.ApproximateNumberOfMessagesNotVisible),
    delayed: Number(attributes.ApproximateNumberOfMessagesDelayed),
  };
  if (Object.values(state).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('SQS returned invalid queue counts');
  }
  return state;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate an application port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  return port;
}

function startApplication(port: number): AppProcess {
  if (closing) {
    throw new Error('Cannot start another process during cleanup');
  }
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', 'src/main.ts'], cwd: projectRoot,
    env: {
      ...process.env, PORT: String(port), SQS_CONSUMER_ENABLED: 'true',
      OUTBOX_PUBLISHER_ENABLED: 'true', OUTBOX_POLL_INTERVAL_MS: '50',
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  const instance: AppProcess = {
    child, port, committedTransactions: new Set(), acknowledgedMessages: 0,
    publishedEvents: 0, outputLines: 0, drains: [],
  };
  applications.push(instance);
  instance.drains.push(readOutput(instance, child.stdout), readOutput(instance, child.stderr));
  return instance;
}

async function readOutput(instance: AppProcess, stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      buffered += decoder.decode(part.value, { stream: true });
      let end = buffered.indexOf('\n');
      while (end >= 0) {
        recordOutput(instance, buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        end = buffered.indexOf('\n');
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) {
      recordOutput(instance, buffered);
    }
  } finally {
    reader.releaseLock();
  }
}

function recordOutput(instance: AppProcess, line: string): void {
  instance.outputLines++;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof entry !== 'object' || entry === null) {
    return;
  }
  if ('message' in entry && entry.message === 'wager transaction finished' &&
      'idempotentReplay' in entry && entry.idempotentReplay === false &&
      'transactionId' in entry && typeof entry.transactionId === 'string') {
    instance.committedTransactions.add(entry.transactionId);
  }
  if ('message' in entry && entry.message === 'wager message handled' && 'decision' in entry && entry.decision === 'ack') {
    instance.acknowledgedMessages++;
  }
  if ('message' in entry && entry.message === 'outbox messages published' && 'eventIds' in entry && Array.isArray(entry.eventIds)) {
    instance.publishedEvents += entry.eventIds.length;
  }
}

async function isReady(instance: AppProcess): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/health/ready`, { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

async function waitForReady(instance: AppProcess): Promise<void> {
  await waitUntil('application readiness', async () => {
    if (instance.child.exitCode !== null) {
      throw new Error(`Application exited before readiness: pid=${instance.child.pid}, exitCode=${instance.child.exitCode}`);
    }
    return isReady(instance);
  }, 15_000);
}

async function stopApplications(): Promise<void> {
  closing = true;
  try {
    await Promise.all(applications.map(async (instance) => {
      if (instance.child.exitCode === null) {
        instance.child.kill('SIGTERM');
        await Promise.race([instance.child.exited, Bun.sleep(5_000)]);
      }
    }));
  } finally {
    for (const instance of applications) {
      if (instance.child.exitCode === null) {
        instance.child.kill(9);
      }
    }
    await Promise.allSettled(applications.map((instance) => instance.child.exited));
    await Promise.allSettled(applications.flatMap((instance) => instance.drains));
  }
}

async function waitUntil(name: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${name}`);
}

async function databaseState(walletId: string): Promise<DatabaseState> {
  const rows = await orm.em.getConnection().execute<DatabaseState[]>(
    `select (select count(*)::int from wager_transactions where kind = 'BET') as bets,
            (select count(*)::int from outbox_messages where published_at is null) as pending_outbox,
            (select count(*)::int from wager_transactions where status = 'PENDING_REFERENCE') as pending_reference,
            (select count(*)::int from inbox_messages) as inbox,
            balance_cents::text as balance from wallets where id = ?`, [walletId],
  );
  const state = rows[0];
  if (!state) {
    throw new Error('Test wallet disappeared');
  }
  expect(BigInt(state.balance)).toBeGreaterThanOrEqual(0n);
  return state;
}

function bet(wallet: { id: string; playerId: string }) {
  const externalTransactionId = newId();
  return {
    providerId: 'multi-instance-provider', externalTransactionId, idempotencyKey: `e2e:${externalTransactionId}`,
    playerId: wallet.playerId, walletId: wallet.id, roundId: 'round-1', gameId: 'game-1',
    kind: WagerTransactionKind.Bet, money: { amount: '1.00', currency: 'BRL' },
  };
}

async function sendMessages(envelopes: { messageId: string }[]): Promise<void> {
  const deliveries = [...envelopes, ...envelopes.slice(0, 20)];
  for (let start = 0; start < deliveries.length; start += 10) {
    const response = await client.send(new SendMessageBatchCommand({
      QueueUrl: transactionsQueue,
      Entries: deliveries.slice(start, start + 10).map((envelope, index) => ({
        Id: String(index), MessageBody: JSON.stringify(envelope),
        MessageGroupId: envelope.messageId, MessageDeduplicationId: newId(),
      })),
    }), { abortSignal: AbortSignal.timeout(5_000) });
    if (response.Failed?.length) {
      throw new Error('SQS rejected an E2E delivery batch');
    }
    expect(response.Successful).toHaveLength(Math.min(10, deliveries.length - start));
  }
}

async function sendHttp(input: ReturnType<typeof bet>, ports: number[], initialIndex: number): Promise<number> {
  for (let attempt = 0; attempt < 20 && !closing; attempt++) {
    const port = ports[(initialIndex + attempt) % ports.length];
    try {
      const response = await fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
        body: JSON.stringify(input), signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      if (response.status === 200 || response.status === 422) {
        return attempt;
      }
      if (response.status !== 503) {
        throw new Error(`Unexpected HTTP response: ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unexpected HTTP response:')) {
        throw error;
      }
    }
    await Bun.sleep(50);
  }
  throw new Error('HTTP BET did not finish within its retry limit');
}

test('three real application processes preserve final consistency after a forced kill and restart', async () => {
  const started = Date.now();
  let stateAtKill: DatabaseState | undefined;
  try {
    const wallet = await new CreateWalletUseCase(orm.em).execute({
      playerId: newId(), initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const ports: number[] = [];
    while (ports.length < 3) {
      const port = await freePort();
      if (!ports.includes(port)) {
        ports.push(port);
      }
    }
    const initialApps = ports.map(startApplication);
    expect(new Set(initialApps.map((instance) => instance.child.pid)).size).toBe(3);
    await Promise.all(initialApps.map(waitForReady));
    console.log(JSON.stringify({ event: 'three_processes_ready', pids: initialApps.map((instance) => instance.child.pid), ports }));

    const envelopes = Array.from({ length: 150 }, () => ({
      messageId: newId(), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: bet(wallet),
    }));
    const httpInputs = Array.from({ length: 30 }, () => bet(wallet));
    const workload = Promise.allSettled([
      sendMessages(envelopes), Promise.all(httpInputs.map((input, index) => sendHttp(input, ports, index % ports.length))),
    ]);

    await waitUntil('all three processes to commit during the workload', async () => {
      const state = await databaseState(wallet.id);
      return state.bets > 0 && initialApps.every((instance) => instance.committedTransactions.size > 0);
    }, 15_000);

    const victim = initialApps[0]!;
    const locker = orm.em.fork();
    let replacement: AppProcess | undefined;
    await locker.begin();
    try {
      await locker.findOneOrFail(WalletEntity, wallet.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      stateAtKill = await databaseState(wallet.id);
      expect(stateAtKill.bets).toBeGreaterThan(0);
      expect(stateAtKill.bets).toBeLessThan(180);
      const inProgress = await queueState(transactionsQueue);
      expect(inProgress.visible + inProgress.inFlight).toBeGreaterThan(0);
      victim.child.kill('SIGKILL');
      const exitCode = await Promise.race([
        victim.child.exited,
        Bun.sleep(5_000).then(() => { throw new Error('Forcibly killed process did not exit'); }),
      ]);
      expect(await isReady(victim)).toBe(false);
      expect(initialApps.slice(1).every((instance) => instance.child.exitCode === null)).toBe(true);
      console.log(JSON.stringify({
        event: 'process_killed', pid: victim.child.pid, exitCode,
        betsAtKill: stateAtKill.bets, queueAtKill: inProgress,
      }));
      await Bun.sleep(2_000);
      const beforeRestart = await queueState(transactionsQueue);
      replacement = startApplication(victim.port);
      expect(replacement.child.pid).not.toBe(victim.child.pid);
      await waitForReady(replacement);
      await waitUntil('replacement to receive work', async () => {
        const afterRestart = await queueState(transactionsQueue);
        return afterRestart.inFlight > beforeRestart.inFlight;
      }, 5_000);
      console.log(JSON.stringify({ event: 'process_restarted', pid: replacement.child.pid, port: replacement.port }));
    } finally {
      await locker.rollback();
    }
    if (!replacement) {
      throw new Error('Replacement process did not start');
    }
    const completed = await workload;
    let httpRetries = 0;
    for (const result of completed) {
      if (result.status === 'rejected') {
        throw new Error('An E2E producer failed');
      }
      if (Array.isArray(result.value)) {
        httpRetries = result.value.reduce((sum, count) => sum + count, 0);
      }
    }

    let stable = 0;
    await waitUntil('database, outbox and SQS convergence', async () => {
      const [state, queue] = await Promise.all([databaseState(wallet.id), queueState(transactionsQueue)]);
      expect([initialApps[1]!, initialApps[2]!, replacement].every((instance) => instance.child.exitCode === null)).toBe(true);
      if (state.bets === 180 && state.inbox === 150 && state.pending_outbox === 0 && state.pending_reference === 0 &&
          queue.visible + queue.inFlight + queue.delayed === 0) {
        stable++;
      } else {
        stable = 0;
      }
      return stable >= 2;
    }, 75_000);

    const em = orm.em.fork();
    const transactions = await em.find(WagerTransactionEntity, { walletId: wallet.id, kind: WagerTransactionKind.Bet });
    const processed = transactions.filter((transaction) => transaction.status === WagerTransactionStatus.Processed);
    const rejected = transactions.filter((transaction) => transaction.status === WagerTransactionStatus.Rejected);
    expect(transactions).toHaveLength(180);
    expect(processed).toHaveLength(100);
    expect(rejected).toHaveLength(80);
    expect(rejected.every((transaction) => transaction.failureCode === FailureCode.InsufficientFunds)).toBe(true);
    expect(transactions.every((transaction) => transaction.observedBalanceCents !== undefined && transaction.observedBalanceCents >= 0n)).toBe(true);
    expect(transactions.map((transaction) => transaction.idempotencyKey).sort()).toEqual([
      ...envelopes.map((envelope) => envelope.data.idempotencyKey), ...httpInputs.map((input) => input.idempotencyKey),
    ].sort());
    expect(new Set(transactions.map((transaction) => transaction.idempotencyKey)).size).toBe(180);
    expect(await em.count(WagerTransactionEntity, {})).toBe(181);
    const storedWallet = await em.findOneOrFail(WalletEntity, wallet.id);
    const ledger = await em.find(WalletLedgerEntryEntity, { walletId: wallet.id });
    const debits = ledger.filter((entry) => entry.direction === LedgerDirection.Debit);
    expect(storedWallet.balanceCents).toBe(0n);
    expect(balanceFromLedger(ledger)).toBe(storedWallet.balanceCents);
    expect(ledger).toHaveLength(101);
    expect(debits).toHaveLength(100);
    expect(new Set(debits.map((entry) => entry.transactionId)).size).toBe(100);
    expect(debits.every((entry) => entry.amountCents === 100n)).toBe(true);
    expect(ledger.every((entry) => entry.balanceBeforeCents >= 0n && entry.balanceAfterCents >= 0n)).toBe(true);
    const inbox = await em.find(InboxMessageEntity, {});
    expect(inbox).toHaveLength(150);
    expect(inbox.map((message) => message.messageId).sort()).toEqual(envelopes.map((envelope) => envelope.messageId).sort());
    expect(inbox.every((message) => message.consumerName === WAGER_TRANSACTIONS_CONSUMER_NAME && message.processedAt instanceof Date)).toBe(true);
    const outbox = await em.find(OutboxMessageEntity, {});
    expect(outbox).toHaveLength(282);
    expect(outbox.every((message) => message.publishedAt instanceof Date)).toBe(true);
    expect(await em.count(WagerTransactionEntity, { status: WagerTransactionStatus.PendingReference })).toBe(0);
    expect(await queueState(transactionsQueue)).toEqual({ visible: 0, inFlight: 0, delayed: 0 });
    expect(await queueState(dlq)).toEqual({ visible: 0, inFlight: 0, delayed: 0 });
    expect(replacement.committedTransactions.size).toBeGreaterThan(0);
    expect(replacement.acknowledgedMessages).toBeGreaterThan(0);
    console.log(JSON.stringify({
      event: 'multi_instance_consistency_verified', elapsedMs: Date.now() - started,
      betsAtKill: stateAtKill.bets, uniqueBets: transactions.length, processed: processed.length, rejected: rejected.length,
      balance: '0.00', ledgerBalance: '0.00', debits: debits.length, inbox: inbox.length,
      publishedOutbox: outbox.length, pendingOutbox: 0, dlq: 0, httpRetries,
      processes: applications.map((instance) => ({
        pid: instance.child.pid, port: instance.port, committedBets: instance.committedTransactions.size,
        acknowledgedMessages: instance.acknowledgedMessages, publishedEvents: instance.publishedEvents,
      })),
    }));
  } finally {
    await stopApplications();
  }
}, 120_000);
