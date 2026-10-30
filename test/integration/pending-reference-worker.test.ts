import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config';
import { MetricsRegistry } from '../../src/shared/metrics/metrics.registry';
import { newId } from '../../src/shared/new-id';
import { PendingReferenceWorker } from '../../src/modules/wagering/application/pending-reference-worker';
import { ProcessWagerTransactionUseCase, type ProcessWagerTransactionInput } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionEntity } from '../../src/modules/wagering/infrastructure/wager-transaction.entity';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/create-wallet.use-case';
import { LedgerDirection } from '../../src/modules/wallet/domain/wallet-ledger-entry';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/wallet/infrastructure/wallet-ledger-entry.entity';
import { balanceFromLedger, truncateAll } from './helpers';

let orm: MikroORM;
let metrics: MetricsRegistry;
let processTransaction: ProcessWagerTransactionUseCase;
let worker: PendingReferenceWorker;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  await orm.migrator.up();
});

beforeEach(async () => {
  await truncateAll(orm);
  metrics = new MetricsRegistry();
  processTransaction = new ProcessWagerTransactionUseCase(orm.em, metrics);
  worker = new PendingReferenceWorker(orm.em, metrics, { maxAttempts: 2, retryBaseSeconds: 0 });
});

afterAll(async () => {
  await orm.close();
});

async function openWallet() {
  return new CreateWalletUseCase(orm.em).execute({
    playerId: newId(), initialBalance: { amount: '100.00', currency: 'BRL' },
  });
}

function request(
  wallet: { id: string; playerId: string },
  externalTransactionId: string,
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
): ProcessWagerTransactionInput {
  return {
    providerId: 'pending-provider', externalTransactionId, idempotencyKey: `pending:${externalTransactionId}`,
    playerId: wallet.playerId, walletId: wallet.id, roundId: 'round-1', gameId: 'game-1',
    kind, money: { amount: '20.00', currency: 'BRL' }, referenceExternalTransactionId,
  };
}

async function row(id: string) {
  return orm.em.fork().findOneOrFail(WagerTransactionEntity, id);
}

interface EventRow {
  event_type: string;
  transaction_id: string;
  failure_code: string | null;
  correlation_id: string;
  causation_id: string;
}

async function events(transactionId: string): Promise<EventRow[]> {
  return orm.em.getConnection().execute<EventRow[]>(
    `select event_type, payload->'data'->>'transactionId' as transaction_id,
            payload->'data'->>'failureCode' as failure_code,
            payload->>'correlationId' as correlation_id, payload->>'causationId' as causation_id
     from outbox_messages where payload->'data'->>'transactionId' = ? order by occurred_at, id`, [transactionId],
  );
}

async function expectBalance(walletId: string, cents: bigint): Promise<void> {
  const em = orm.em.fork();
  const wallet = await em.findOneOrFail(WalletEntity, walletId);
  const ledger = await em.find(WalletLedgerEntryEntity, { walletId });
  expect(wallet.balanceCents).toBe(cents);
  expect(balanceFromLedger(ledger)).toBe(wallet.balanceCents);
}

test('a REFUND received before its BET is resolved with its ledger entry and outbox events', async () => {
  const wallet = await openWallet();
  const refund = await processTransaction.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, 'bet-1'));
  expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
  await processTransaction.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet));

  expect(await worker.processDue()).toBe(1);

  const resolved = await row(refund.transactionId);
  expect(resolved.status).toBe(WagerTransactionStatus.Processed);
  expect(resolved.referenceAttempts).toBe(0);
  expect(resolved.nextReferenceCheckAt).toBeNull();
  expect(resolved.processedAt).toBeInstanceOf(Date);
  await expectBalance(wallet.id, 10000n);
  const ledger = await orm.em.fork().find(WalletLedgerEntryEntity, { transactionId: refund.transactionId });
  expect(ledger).toHaveLength(1);
  expect(ledger[0]!.direction).toBe(LedgerDirection.Credit);
  const messages = await events(refund.transactionId);
  expect(messages.map((message) => message.event_type)).toEqual([
    'WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged',
  ]);
  for (const message of messages.slice(1)) {
    expect(message.transaction_id).toBe(refund.transactionId);
    expect(message.causation_id).toBe(refund.transactionId);
  }
  expect(messages[1]!.correlation_id).toBe(messages[2]!.correlation_id);
  expect(metrics.render()).toContain('wager_transactions_total{status="PROCESSED",kind="REFUND",source="worker"} 1\n');
});

test('a pending REFUND and its pending ROLLBACK are resolved once the BET arrives', async () => {
  const wallet = await openWallet();
  const refund = await processTransaction.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, 'bet-1'));
  const rollback = await processTransaction.execute(request(wallet, 'rollback-1', WagerTransactionKind.Rollback, 'refund-1'));
  expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
  await processTransaction.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet));

  await worker.processDue();
  await worker.processDue();

  expect((await row(refund.transactionId)).status).toBe(WagerTransactionStatus.Processed);
  expect((await row(rollback.transactionId)).status).toBe(WagerTransactionStatus.Processed);
  await expectBalance(wallet.id, 8000n);
  expect(await orm.em.fork().count(WalletLedgerEntryEntity, { transactionId: rollback.transactionId })).toBe(1);
  expect(metrics.render()).toContain('wager_transactions_total{status="PROCESSED",kind="ROLLBACK",source="worker"} 1\n');
});

test('exhausting reference attempts rejects the transaction and enqueues a rejection without changing the balance', async () => {
  const wallet = await openWallet();
  const refund = await processTransaction.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, 'missing'));

  expect(await worker.processDue()).toBe(1);
  expect((await row(refund.transactionId)).referenceAttempts).toBe(1);
  expect(await events(refund.transactionId)).toHaveLength(1);
  expect(metrics.render()).not.toContain('source="worker"');
  expect(await worker.processDue()).toBe(1);

  const rejected = await row(refund.transactionId);
  expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
  expect(rejected.failureCode).toBe(FailureCode.ReferenceNotFound);
  expect(rejected.referenceAttempts).toBe(2);
  expect(rejected.nextReferenceCheckAt).toBeNull();
  expect(rejected.observedBalanceCents).toBe(10000n);
  await expectBalance(wallet.id, 10000n);
  expect(await orm.em.fork().count(WalletLedgerEntryEntity, { transactionId: refund.transactionId })).toBe(0);
  const messages = await events(refund.transactionId);
  expect(messages.map((message) => message.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
  expect(messages[1]!.failure_code).toBe(FailureCode.ReferenceNotFound);
  expect(metrics.render()).toContain('wager_transactions_total{status="REJECTED",kind="REFUND",source="worker"} 1\n');
  expect(await worker.processDue()).toBe(0);
  expect(await events(refund.transactionId)).toHaveLength(2);
});

test('backoff skips an immediate round and grows exponentially up to 300 seconds', async () => {
  const wallet = await openWallet();
  const refund = await processTransaction.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, 'missing'));
  const delayed = new PendingReferenceWorker(orm.em, metrics, { maxAttempts: 5, retryBaseSeconds: 200 });

  const before = Date.now();
  expect(await delayed.processDue()).toBe(1);
  const first = await row(refund.transactionId);
  expect(first.referenceAttempts).toBe(1);
  expect(first.nextReferenceCheckAt!.getTime()).toBeGreaterThanOrEqual(before + 200_000);
  expect(await delayed.processDue()).toBe(0);
  expect((await row(refund.transactionId)).referenceAttempts).toBe(1);
  await orm.em.fork().nativeUpdate(WagerTransactionEntity, refund.transactionId, { nextReferenceCheckAt: new Date(0) });

  const secondStart = Date.now();
  expect(await delayed.processDue()).toBe(1);

  const second = await row(refund.transactionId);
  expect(second.referenceAttempts).toBe(2);
  expect(second.nextReferenceCheckAt!.getTime()).toBeGreaterThanOrEqual(secondStart + 300_000);
  expect(second.nextReferenceCheckAt!.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
  expect(await events(refund.transactionId)).toHaveLength(1);
});

test('two workers racing for the same pending REFUND create only one credit and one pair of resolved events', async () => {
  const wallet = await openWallet();
  const refund = await processTransaction.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, 'bet-1'));
  await processTransaction.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet));
  const secondWorker = new PendingReferenceWorker(orm.em, metrics, { maxAttempts: 2, retryBaseSeconds: 0 });

  const results = await Promise.all([worker.processDue(), secondWorker.processDue()]);

  expect(results.sort()).toEqual([0, 1]);
  expect(await orm.em.fork().count(WalletLedgerEntryEntity, { transactionId: refund.transactionId, direction: LedgerDirection.Credit })).toBe(1);
  expect(await events(refund.transactionId)).toHaveLength(3);
  await expectBalance(wallet.id, 10000n);
  expect(metrics.render()).toContain('wager_transactions_total{status="PROCESSED",kind="REFUND",source="worker"} 1\n');
});

test('replaying the original REFUND after resolution returns its final processed result', async () => {
  const wallet = await openWallet();
  const input = request(wallet, 'refund-1', WagerTransactionKind.Refund, 'bet-1');
  const pending = await processTransaction.execute(input);
  await processTransaction.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet));
  await worker.processDue();

  const replay = await processTransaction.execute(input);

  expect(replay).toMatchObject({ transactionId: pending.transactionId, status: WagerTransactionStatus.Processed, idempotentReplay: true });
  expect(replay.balance.amount).toBe('100.00');
  expect(await events(pending.transactionId)).toHaveLength(3);
  expect(await orm.em.fork().count(WalletLedgerEntryEntity, { transactionId: pending.transactionId })).toBe(1);
  await expectBalance(wallet.id, 10000n);
});

test('each round attempts at most ten due transactions', async () => {
  const wallet = await openWallet();
  for (let index = 0; index < 11; index++) {
    await processTransaction.execute(request(wallet, `refund-${index}`, WagerTransactionKind.Refund, 'missing'));
  }
  const delayed = new PendingReferenceWorker(orm.em, metrics, { maxAttempts: 3, retryBaseSeconds: 60 });

  expect(await delayed.processDue()).toBe(10);
  expect(await delayed.processDue()).toBe(1);
  expect(await delayed.processDue()).toBe(0);

  expect(await orm.em.fork().count(WagerTransactionEntity, { status: WagerTransactionStatus.PendingReference, referenceAttempts: 1 })).toBe(11);
  await expectBalance(wallet.id, 10000n);
});

test('shutdown waits for the active round and one instance does not overlap rounds', async () => {
  const wallet = await openWallet();
  const refund = await processTransaction.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, 'bet-1'));
  await processTransaction.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet));
  const locker = orm.em.fork();
  await locker.begin();
  let released = false;
  try {
    await locker.findOneOrFail(WalletEntity, wallet.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
    const active = worker.processDue();
    expect(await worker.processDue()).toBe(0);
    let stopped = false;
    const shutdown = worker.onApplicationShutdown().then(() => { stopped = true; });
    await Bun.sleep(50);
    expect(stopped).toBe(false);
    await locker.commit();
    released = true;

    expect(await active).toBe(1);
    await shutdown;

    expect(stopped).toBe(true);
    expect((await row(refund.transactionId)).status).toBe(WagerTransactionStatus.Processed);
    await expectBalance(wallet.id, 10000n);
  } finally {
    if (!released) {
      await locker.rollback();
    }
    await worker.onApplicationShutdown();
  }
});
