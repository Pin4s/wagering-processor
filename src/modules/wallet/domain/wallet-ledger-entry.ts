import { Money } from '../../../shared/domain/money';

export enum LedgerDirection {
    Debit = 'DEBIT',
    Credit = 'CREDIT',
}

export class InvalidLedgerEntryError extends Error { }

export interface LedgerEntryState {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: Date;
}

export class WalletLedgerEntry {
    private constructor(
        public readonly id: string,
        public readonly walletId: string,
        public readonly transactionId: string,
        public readonly direction: LedgerDirection,
        public readonly money: Money,
        public readonly balanceBefore: Money,
        public readonly balanceAfter: Money,
        public readonly createdAt: Date,
    ) { }

    static create(state: LedgerEntryState): WalletLedgerEntry {
        if (!state.money.isPositive()) {
            throw new InvalidLedgerEntryError('ledger amount must be positive');
        }
        const entry = WalletLedgerEntry.rehydrate(state);
        if (!entry.isBalanced()) {
            throw new InvalidLedgerEntryError('balanceBefore +/- money does not equal balanceAfter');
        }
        return entry;
    }

    static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
        return new WalletLedgerEntry(
            state.id,
            state.walletId,
            state.transactionId,
            state.direction,
            state.money,
            state.balanceBefore,
            state.balanceAfter,
            state.createdAt,
        );
    }

    isBalanced(): boolean {
        let expected: Money;
        if (this.direction === LedgerDirection.Debit) {
            expected = this.balanceBefore.subtract(this.money);
        } else {
            expected = this.balanceBefore.add(this.money);
        }
        return expected.equals(this.balanceAfter);
    }
}