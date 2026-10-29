import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
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

function request(
  wallet: { id: string; playerId: string },
  externalTransactionId: string,
  kind: WagerTransactionKind,
  amount: string,
  referenceExternalTransactionId?: string,
): ProcessWagerTransactionInput {
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    referenceExternalTransactionId,
  };
}

async function assertWalletMatchesLedger(walletId: string): Promise<bigint> {
  const em = orm.em.fork();
  const wallet = await em.findOneOrFail(WalletEntity, walletId);
  const entries = await em.find(WalletLedgerEntryEntity, { walletId });
  expect(balanceFromLedger(entries)).toBe(wallet.balanceCents);
  return wallet.balanceCents;
}

test('REFUND of a BET gives the money back', async () => {
  const wallet = await openWallet('100.00');
  await process.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet, '20.00'));

  const refund = await process.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, '20.00', 'bet-1'));

  expect(refund.status).toBe(WagerTransactionStatus.Processed);
  expect(refund.balance.amount).toBe('100.00');
  const entries = await orm.em.fork().find(WalletLedgerEntryEntity, { transactionId: refund.transactionId });
  expect(entries[0]!.direction).toBe(LedgerDirection.Credit);
  expect(await assertWalletMatchesLedger(wallet.id)).toBe(10000n);
});

test('ROLLBACK of a BET gives the money back', async () => {
  const wallet = await openWallet('100.00');
  await process.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet, '20.00'));

  const rollback = await process.execute(request(wallet, 'rb-1', WagerTransactionKind.Rollback, '20.00', 'bet-1'));

  expect(rollback.status).toBe(WagerTransactionStatus.Processed);
  expect(rollback.balance.amount).toBe('100.00');
  expect(await assertWalletMatchesLedger(wallet.id)).toBe(10000n);
});

test('ROLLBACK of a WIN takes the prize back', async () => {
  const wallet = await openWallet('100.00');
  await process.execute(request(wallet, 'win-1', WagerTransactionKind.Win, '50.00'));

  const rollback = await process.execute(request(wallet, 'rb-1', WagerTransactionKind.Rollback, '50.00', 'win-1'));

  expect(rollback.status).toBe(WagerTransactionStatus.Processed);
  expect(rollback.balance.amount).toBe('100.00');
  const entries = await orm.em.fork().find(WalletLedgerEntryEntity, { transactionId: rollback.transactionId });
  expect(entries[0]!.direction).toBe(LedgerDirection.Debit);
  expect(await assertWalletMatchesLedger(wallet.id)).toBe(10000n);
});

test('ROLLBACK of a REFUND undoes the refund', async () => {
  const wallet = await openWallet('100.00');
  await process.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet, '20.00'));
  await process.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, '20.00', 'bet-1'));

  const rollback = await process.execute(request(wallet, 'rb-1', WagerTransactionKind.Rollback, '20.00', 'refund-1'));

  expect(rollback.status).toBe(WagerTransactionStatus.Processed);
  expect(rollback.balance.amount).toBe('80.00');
  expect(await assertWalletMatchesLedger(wallet.id)).toBe(8000n);
});

test('a BET can be reversed only once, by REFUND or ROLLBACK (no double credit)', async () => {
  const wallet = await openWallet('100.00');
  await process.execute(request(wallet, 'bet-123', WagerTransactionKind.Bet, '20.00'));

  const refund = await process.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, '20.00', 'bet-123'));
  const secondRefund = await process.execute(request(wallet, 'refund-2', WagerTransactionKind.Refund, '20.00', 'bet-123'));
  const rollback = await process.execute(request(wallet, 'rb-1', WagerTransactionKind.Rollback, '20.00', 'bet-123'));

  expect(refund.status).toBe(WagerTransactionStatus.Processed);
  expect(secondRefund.status).toBe(WagerTransactionStatus.Rejected);
  expect(secondRefund.failureCode).toBe(FailureCode.AlreadyReversed);
  expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
  expect(rollback.failureCode).toBe(FailureCode.AlreadyReversed);

  expect(rollback.balance.amount).toBe('100.00');
  expect(await assertWalletMatchesLedger(wallet.id)).toBe(10000n);
});