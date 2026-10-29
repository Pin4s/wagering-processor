import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config';
import { newId } from '../../src/shared/new-id';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/create-wallet.use-case';
import { LedgerDirection } from '../../src/modules/wallet/domain/wallet-ledger-entry';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/wallet/infrastructure/wallet-ledger-entry.entity';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import {
  IdempotencyConflictError,
  ProcessWagerTransactionInput,
  ProcessWagerTransactionUseCase,
} from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { balanceFromLedger, truncateAll } from './helpers';

let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let process: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  createWallet = new CreateWalletUseCase(orm.em);
  process = new ProcessWagerTransactionUseCase(orm.em);
});

afterAll(async () => {
  await orm.close();
});

beforeEach(async () => {
  await truncateAll(orm);
});

async function openWallet(amount: string) {
  return createWallet.execute({ playerId: newId(), initialBalance: { amount, currency: 'BRL' } });
}

async function warmUpConnections(count: number): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, () => orm.em.getConnection().execute('select pg_sleep(0.05)')),
  );
}

function bet(walletId: string, playerId: string, externalTransactionId: string, amount: string): ProcessWagerTransactionInput {
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: 'BRL' },
  };
}

async function assertWalletMatchesLedger(walletId: string): Promise<bigint> {
  const em = orm.em.fork();
  const wallet = await em.findOneOrFail(WalletEntity, walletId);
  const entries = await em.find(WalletLedgerEntryEntity, { walletId });
  expect(balanceFromLedger(entries)).toBe(wallet.balanceCents);
  return wallet.balanceCents;
}

test('BET debits the wallet and writes one ledger entry', async () => {
  const wallet = await openWallet('1000.00');
  const result = await process.execute(bet(wallet.id, wallet.playerId, 'tx-1', '25.00'));

  expect(result.status).toBe(WagerTransactionStatus.Processed);
  expect(result.balance).toEqual({ amount: '975.00', currency: 'BRL' });
  expect(result.idempotentReplay).toBe(false);
  expect(await assertWalletMatchesLedger(wallet.id)).toBe(97500n);
});

test('BET without enough balance is REJECTED and does not touch the balance', async () => {
  const wallet = await openWallet('10.00');
  const result = await process.execute(bet(wallet.id, wallet.playerId, 'tx-1', '25.00'));

  expect(result.status).toBe(WagerTransactionStatus.Rejected);
  expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
  expect(result.balance.amount).toBe('10.00');
  expect(await assertWalletMatchesLedger(wallet.id)).toBe(1000n);
});

test('replay returns the original result, including the balance of that moment', async () => {
  const wallet = await openWallet('1000.00');
  const first = await process.execute(bet(wallet.id, wallet.playerId, 'tx-1', '25.00'));
  await process.execute(bet(wallet.id, wallet.playerId, 'tx-2', '100.00'));

  const replay = await process.execute(bet(wallet.id, wallet.playerId, 'tx-1', '25.00'));

  expect(replay.idempotentReplay).toBe(true);
  expect(replay.transactionId).toBe(first.transactionId);
  expect(replay.balance.amount).toBe('975.00');  
  expect(await assertWalletMatchesLedger(wallet.id)).toBe(87500n);
});

test('same Idempotency-Key with a different payload is a conflict, not a replay', async () => {
  const wallet = await openWallet('1000.00');
  await process.execute(bet(wallet.id, wallet.playerId, 'tx-1', '25.00'));

  await expect(process.execute(bet(wallet.id, wallet.playerId, 'tx-1', '30.00'))).rejects.toThrow(
    IdempotencyConflictError,
  );
  expect(await assertWalletMatchesLedger(wallet.id)).toBe(97500n);
});

test('README scenario: balance 100, two bets of 80 in parallel -> one PROCESSED, one REJECTED', async () => {
  const wallet = await openWallet('100.00');
  await warmUpConnections(10);

  const results = await Promise.all([
    process.execute(bet(wallet.id, wallet.playerId, 'tx-a', '80.00')),
    process.execute(bet(wallet.id, wallet.playerId, 'tx-b', '80.00')),
  ]);

  const statuses = results.map((r) => r.status).sort();
  expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);

  const debits = await orm.em.fork().count(WalletLedgerEntryEntity, {
    walletId: wallet.id,
    direction: LedgerDirection.Debit,
  });
  expect(debits).toBe(1);
  expect(await assertWalletMatchesLedger(wallet.id)).toBe(2000n);
});

test('10 bets of 80 in parallel on balance 100 -> exactly one PROCESSED', async () => {
  const wallet = await openWallet('100.00');
  await warmUpConnections(10);

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      process.execute(bet(wallet.id, wallet.playerId, `tx-${index}`, '80.00')),
    ),
  );

  expect(results.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(1);
  expect(results.filter((result) => result.status === WagerTransactionStatus.Rejected)).toHaveLength(9);
  expect(await assertWalletMatchesLedger(wallet.id)).toBe(2000n);
});

test('the wallet lock makes a concurrent operation wait and see the latest balance', async () => {
  const wallet = await openWallet('100.00');
  await warmUpConnections(10);

  const em = orm.em.fork();
  await em.begin();

  try {
    const lockedWallet = await em.findOneOrFail(WalletEntity, { id: wallet.id }, {
      lockMode: LockMode.PESSIMISTIC_WRITE,
    });

    let finished = false;
    const pendingBet = process.execute(bet(wallet.id, wallet.playerId, 'tx-waiting', '80.00')).then((result) => {
      finished = true;
      return result;
    });

    await Bun.sleep(300);
    const finishedWhileLocked = finished;

    lockedWallet.balanceCents = 0n;
    await em.commit();

    const result = await pendingBet;

    expect(finishedWhileLocked).toBe(false);
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance.amount).toBe('0.00');
  } finally {
    if (em.isInTransaction()) {
      await em.rollback();
    }
  }
});

test('the same BET sent 50 times in parallel debits only once', async () => {
  const wallet = await openWallet('1000.00');
  const request = bet(wallet.id, wallet.playerId, 'tx-1', '25.00');

  const results = await Promise.all(Array.from({ length: 50 }, () => process.execute(request)));

  const originals = results.filter((r) => !r.idempotentReplay);
  expect(originals).toHaveLength(1);
  for (const result of results) {
    expect(result.transactionId).toBe(originals[0]!.transactionId);
    expect(result.balance.amount).toBe('975.00');
  }
  expect(await assertWalletMatchesLedger(wallet.id)).toBe(97500n);
});

test('different wallets are processed in parallel without interfering', async () => {
  const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet('100.00')));

  const results = await Promise.all(
    wallets.map((w) => process.execute(bet(w.id, w.playerId, `tx-${w.id}`, '30.00'))),
  );

  for (const result of results) {
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('70.00');
  }
  for (const w of wallets) {
    expect(await assertWalletMatchesLedger(w.id)).toBe(7000n);
  }
});
