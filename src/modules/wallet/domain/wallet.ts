import { Money } from '../../../shared/domain/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export class InvalidWalletError extends Error { }
export class InsufficientBalanceError extends Error { }

export interface WalletState {
    id: string;
    playerId: string;
    currency: string;
    balance: Money;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

export class Wallet {
    private constructor(
        public readonly id: string,
        public readonly playerId: string,
        public readonly currency: string,
        private _balance: Money,
        private _version: number,
        public readonly createdAt: Date,
        private _updatedAt: Date,
    ) { }

    static open(props: {
        id: string;
        playerId: string;
        initialBalance: Money;
        openingTransactionId: string;
        openingEntryId: string;
    }): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
        if (props.initialBalance.isNegative()) {
            throw new InvalidWalletError('initial balance cannot be negative');
        }
        const now = new Date();
        const wallet = new Wallet(
            props.id,
            props.playerId,
            props.initialBalance.currency,
            props.initialBalance,
            1,
            now,
            now,
        );

        let openingEntry: WalletLedgerEntry | undefined = undefined;
        if (props.initialBalance.isPositive()) {
            openingEntry = WalletLedgerEntry.create({
                id: props.openingEntryId,
                walletId: props.id,
                transactionId: props.openingTransactionId,
                direction: LedgerDirection.Credit,
                money: props.initialBalance,
                balanceBefore: Money.zero(props.initialBalance.currency),
                balanceAfter: props.initialBalance,
                createdAt: now,
            });
        }

        return { wallet, openingEntry };
    }

    static rehydrate(state: WalletState): Wallet {
        return new Wallet(
            state.id,
            state.playerId,
            state.currency,
            state.balance,
            state.version,
            state.createdAt,
            state.updatedAt,
        );
    }

    credit(props: { entryId: string; transactionId: string; money: Money; }): WalletLedgerEntry {
        const now = new Date();
        const balanceAfter = this._balance.add(props.money);
        const entry = WalletLedgerEntry.create({
            id: props.entryId,
            walletId: this.id,
            transactionId: props.transactionId,
            direction: LedgerDirection.Credit,
            money: props.money,
            balanceBefore: this._balance,
            balanceAfter,
            createdAt: now,
        });
        this._balance = balanceAfter;
        this._version += 1;
        this._updatedAt = now;
        return entry;
    }

    debit(props: { entryId: string; transactionId: string; money: Money; }): WalletLedgerEntry {
        const now = new Date();
        if (this._balance.isLessThan(props.money)) {
            throw new InsufficientBalanceError('insufficient balance');
        }
        const balanceAfter = this._balance.subtract(props.money);
        const entry = WalletLedgerEntry.create({
            id: props.entryId,
            walletId: this.id,
            transactionId: props.transactionId,
            direction: LedgerDirection.Debit,
            money: props.money,
            balanceBefore: this._balance,
            balanceAfter,
            createdAt: now,
        });
        this._balance = balanceAfter;
        this._version += 1;
        this._updatedAt = now;
        return entry;
    }

    get balance(): Money {
        return this._balance;
    }

    get version(): number {
        return this._version;
    }

    get updatedAt(): Date {
        return this._updatedAt;
    }
}