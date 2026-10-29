import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config';
import { InvalidMoneyError } from '../../src/shared/domain/money';
import { newId } from '../../src/shared/new-id';
import { CreateWalletUseCase, WalletAlreadyExistsError } from '../../src/modules/wallet/application/create-wallet.use-case';
import { LedgerDirection } from '../../src/modules/wallet/domain/wallet-ledger-entry';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/wallet/infrastructure/wallet-ledger-entry.entity';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionEntity } from '../../src/modules/wagering/infrastructure/wager-transaction.entity';

let orm: MikroORM;
let useCase: CreateWalletUseCase;

beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    useCase = new CreateWalletUseCase(orm.em);
});

afterAll(async () => {
    await orm.close();
});

beforeEach(async () => {
    await orm.em
        .getConnection()
        .execute('truncate table wallet_ledger_entries, wager_transactions, wallets cascade');
});

function balanceFromLedger(entries: WalletLedgerEntryEntity[]): bigint {
    let total = 0n;
    for (const entry of entries) {
        if (entry.direction === LedgerDirection.Credit) {
            total = total + entry.amountCents;
        } else {
            total = total - entry.amountCents;
        }
    }
    return total;
}

test('creates wallet, OPENING transaction and ledger entry together', async () => {
    const wallet = await useCase.execute({
        playerId: newId(),
        initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    const em = orm.em.fork();
    const stored = await em.findOneOrFail(WalletEntity, wallet.id);
    const transactions = await em.find(WagerTransactionEntity, { walletId: wallet.id });
    const entries = await em.find(WalletLedgerEntryEntity, { walletId: wallet.id });

    expect(stored.balanceCents).toBe(100000n);
    expect(stored.version).toBe(1);

    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.kind).toBe(WagerTransactionKind.Opening);
    expect(transactions[0]!.status).toBe(WagerTransactionStatus.Processed);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.transactionId).toBe(transactions[0]!.id);

    expect(balanceFromLedger(entries)).toBe(stored.balanceCents);
});

test('zero initial balance creates only the wallet', async () => {
    const wallet = await useCase.execute({
        playerId: newId(),
        initialBalance: { amount: '0.00', currency: 'BRL' },
    });

    const em = orm.em.fork();
    expect(await em.count(WalletEntity, { id: wallet.id })).toBe(1);
    expect(await em.count(WagerTransactionEntity, { walletId: wallet.id })).toBe(0);
    expect(await em.count(WalletLedgerEntryEntity, { walletId: wallet.id })).toBe(0);
});

test('duplicate wallet for same player and currency fails and writes nothing', async () => {
    const playerId = newId();
    await useCase.execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });

    await expect(
        useCase.execute({ playerId, initialBalance: { amount: '50.00', currency: 'BRL' } }),
    ).rejects.toThrow(WalletAlreadyExistsError);


    const em = orm.em.fork();
    expect(await em.count(WalletEntity, { playerId })).toBe(1);
    expect(await em.count(WagerTransactionEntity, {})).toBe(1);
    expect(await em.count(WalletLedgerEntryEntity, {})).toBe(1);
});

test('invalid amount fails before touching the database', async () => {
    await expect(
        useCase.execute({ playerId: newId(), initialBalance: { amount: '10.999', currency: 'BRL' } }),
    ).rejects.toThrow(InvalidMoneyError);

    expect(await orm.em.fork().count(WalletEntity, {})).toBe(0);
});