import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config';
import { newId } from '../../src/shared/new-id';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/create-wallet.use-case';
import { LedgerDirection } from '../../src/modules/wallet/domain/wallet-ledger-entry';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/wallet/infrastructure/wallet-ledger-entry.entity';
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
    walletId: string,
    playerId: string,
    externalTransactionId: string,
    kind: WagerTransactionKind,
    amount: string,
): ProcessWagerTransactionInput {
    return {
        idempotencyKey: `provider-a:${externalTransactionId}`,
        providerId: 'provider-a',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind,
        money: { amount, currency: 'BRL' },
    };
}

async function storedWallet(walletId: string) {
    return orm.em.fork().findOneOrFail(WalletEntity, walletId);
}

async function assertWalletMatchesLedger(walletId: string): Promise<void> {
    const em = orm.em.fork();
    const wallet = await em.findOneOrFail(WalletEntity, walletId);
    const entries = await em.find(WalletLedgerEntryEntity, { walletId });
    expect(balanceFromLedger(entries)).toBe(wallet.balanceCents);
}

test('WIN credits the wallet, bumps the version and writes a CREDIT entry', async () => {
    const wallet = await openWallet('100.00');
    const result = await process.execute(request(wallet.id, wallet.playerId, 'win-1', WagerTransactionKind.Win, '60.00'));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('160.00');

    const stored = await storedWallet(wallet.id);
    expect(stored.version).toBe(2);

    const entries = await orm.em.fork().find(WalletLedgerEntryEntity, { transactionId: result.transactionId });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.direction).toBe(LedgerDirection.Credit);
    await assertWalletMatchesLedger(wallet.id);
});

test('LOSS is PROCESSED without touching balance, version or ledger', async () => {
    const wallet = await openWallet('100.00');
    const result = await process.execute(request(wallet.id, wallet.playerId, 'loss-1', WagerTransactionKind.Loss, '25.00'));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('100.00');

    const stored = await storedWallet(wallet.id);
    expect(stored.version).toBe(1);

    const entries = await orm.em.fork().count(WalletLedgerEntryEntity, { transactionId: result.transactionId });
    expect(entries).toBe(0);
    await assertWalletMatchesLedger(wallet.id);
});

test('LOSS with zero amount is accepted', async () => {
    const wallet = await openWallet('100.00');
    const result = await process.execute(request(wallet.id, wallet.playerId, 'loss-1', WagerTransactionKind.Loss, '0.00'));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('100.00');
});

test('a full round: BET then WIN, and BET then LOSS', async () => {
    const wallet = await openWallet('1000.00');

    await process.execute(request(wallet.id, wallet.playerId, 'bet-1', WagerTransactionKind.Bet, '25.00'));
    const win = await process.execute(request(wallet.id, wallet.playerId, 'win-1', WagerTransactionKind.Win, '60.00'));
    expect(win.balance.amount).toBe('1035.00');

    await process.execute(request(wallet.id, wallet.playerId, 'bet-2', WagerTransactionKind.Bet, '35.00'));
    const loss = await process.execute(request(wallet.id, wallet.playerId, 'loss-2', WagerTransactionKind.Loss, '35.00'));
    expect(loss.balance.amount).toBe('1000.00');

    const entries = await orm.em.fork().count(WalletLedgerEntryEntity, { walletId: wallet.id });
    expect(entries).toBe(4);
    await assertWalletMatchesLedger(wallet.id);
});

test('WIN replay returns the original result and credits only once', async () => {
    const wallet = await openWallet('100.00');
    const win = request(wallet.id, wallet.playerId, 'win-1', WagerTransactionKind.Win, '60.00');

    const first = await process.execute(win);
    const replay = await process.execute(win);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance.amount).toBe('160.00');

    const stored = await storedWallet(wallet.id);
    expect(stored.balanceCents).toBe(16000n);
    await assertWalletMatchesLedger(wallet.id);
});