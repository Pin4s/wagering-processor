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
import { WagerTransactionEntity } from '../../src/modules/wagering/infrastructure/wager-transaction.entity';

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

async function assertStoredRejection(transactionId: string, code: FailureCode): Promise<void> {
    const stored = await orm.em.fork().findOneOrFail(WagerTransactionEntity, transactionId);
    expect(stored.status).toBe(WagerTransactionStatus.Rejected);
    expect(stored.failureCode).toBe(code);
}

test('REFUND can only reference a BET (rule 3)', async () => {
    const wallet = await openWallet('100.00');
    await process.execute(request(wallet, 'win-1', WagerTransactionKind.Win, '50.00'));

    const refund = await process.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, '50.00', 'win-1'));

    expect(refund.failureCode).toBe(FailureCode.InvalidReferenceKind);
    expect(refund.balance.amount).toBe('150.00');
    await assertStoredRejection(refund.transactionId, FailureCode.InvalidReferenceKind);
});

test('ROLLBACK cannot reference a LOSS (rule 3)', async () => {
    const wallet = await openWallet('100.00');
    await process.execute(request(wallet, 'loss-1', WagerTransactionKind.Loss, '20.00'));

    const rollback = await process.execute(request(wallet, 'rb-1', WagerTransactionKind.Rollback, '20.00', 'loss-1'));

    expect(rollback.failureCode).toBe(FailureCode.InvalidReferenceKind);
    expect(await assertWalletMatchesLedger(wallet.id)).toBe(10000n);
});

test('reversal amount must equal the reference amount (rule 5)', async () => {
    const wallet = await openWallet('100.00');
    await process.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet, '20.00'));

    const refund = await process.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, '15.00', 'bet-1'));

    expect(refund.failureCode).toBe(FailureCode.AmountMismatch);
    expect(refund.balance.amount).toBe('80.00');
    await assertStoredRejection(refund.transactionId, FailureCode.AmountMismatch);
});

test('reference from another round is a mismatch (rule 2)', async () => {
    const wallet = await openWallet('100.00');
    await process.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet, '20.00'));

    const otherRound = { ...request(wallet, 'refund-1', WagerTransactionKind.Refund, '20.00', 'bet-1'), roundId: 'round-2' };
    const refund = await process.execute(otherRound);

    expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect(refund.balance.amount).toBe('80.00');
    await assertStoredRejection(refund.transactionId, FailureCode.ReferenceMismatch);
});

test('a REJECTED reference cannot be reversed', async () => {
    const wallet = await openWallet('10.00');
    await process.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet, '25.00'));

    const refund = await process.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, '25.00', 'bet-1'));

    expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(refund.balance.amount).toBe('10.00');
    await assertStoredRejection(refund.transactionId, FailureCode.ReferenceNotProcessed);
});

test('reversal that would make the balance negative is rejected with its own code (rule 9)', async () => {
    const wallet = await openWallet('100.00');
    await process.execute(request(wallet, 'win-1', WagerTransactionKind.Win, '50.00'));
    await process.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet, '140.00'));

    const rollback = await process.execute(request(wallet, 'rb-1', WagerTransactionKind.Rollback, '50.00', 'win-1'));

    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(rollback.balance.amount).toBe('10.00');
    await assertStoredRejection(rollback.transactionId, FailureCode.ReversalInsufficientFunds);
    expect(await assertWalletMatchesLedger(wallet.id)).toBe(1000n);
});

test('two REFUNDs of the same BET in parallel -> exactly one applied', async () => {
    const wallet = await openWallet('100.00');
    await process.execute(request(wallet, 'bet-1', WagerTransactionKind.Bet, '20.00'));

    const results = await Promise.all([
        process.execute(request(wallet, 'refund-a', WagerTransactionKind.Refund, '20.00', 'bet-1')),
        process.execute(request(wallet, 'refund-b', WagerTransactionKind.Refund, '20.00', 'bet-1')),
    ]);

    const applied = results.filter((r) => r.status === WagerTransactionStatus.Processed);
    expect(applied).toHaveLength(1);
    expect(await assertWalletMatchesLedger(wallet.id)).toBe(10000n);
});

test('REFUND that arrives before its BET is stored as PENDING_REFERENCE (rule 8)', async () => {
    const wallet = await openWallet('100.00');

    const refund = await process.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, '20.00', 'bet-late'));

    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.balance.amount).toBe('100.00');

    const em = orm.em.fork();
    const stored = await em.findOneOrFail(WagerTransactionEntity, refund.transactionId);
    expect(stored.status).toBe(WagerTransactionStatus.PendingReference);
    expect(await em.count(WalletLedgerEntryEntity, { transactionId: refund.transactionId })).toBe(0);
    expect(await assertWalletMatchesLedger(wallet.id)).toBe(10000n);
});

test('replay of a pending reversal returns PENDING_REFERENCE with the current balance', async () => {
    const wallet = await openWallet('100.00');
    const pending = request(wallet, 'refund-1', WagerTransactionKind.Refund, '20.00', 'bet-late');

    const first = await process.execute(pending);
    await process.execute(request(wallet, 'bet-other', WagerTransactionKind.Bet, '30.00'));  
    const replay = await process.execute(pending);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.status).toBe(WagerTransactionStatus.PendingReference);
    expect(replay.balance.amount).toBe('70.00');
});

test('ROLLBACK of a pending REFUND also waits as PENDING_REFERENCE', async () => {
    const wallet = await openWallet('100.00');
    await process.execute(request(wallet, 'refund-1', WagerTransactionKind.Refund, '20.00', 'bet-late'));

    const rollback = await process.execute(request(wallet, 'rb-1', WagerTransactionKind.Rollback, '20.00', 'refund-1'));

    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
    expect(await assertWalletMatchesLedger(wallet.id)).toBe(10000n);
});