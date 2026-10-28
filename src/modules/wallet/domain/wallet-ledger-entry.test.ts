import { expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../../shared/domain/money';
import { InvalidLedgerEntryError, LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

test('rehydrate builds the ledger entry with the provided fields', () => {
    const entry = WalletLedgerEntry.rehydrate({
        id: 'e1',
        walletId: 'w1',
        transactionId: 't1',
        direction: LedgerDirection.Debit,
        money: brl('80.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('20.00'),
        createdAt: new Date('2026-10-28T12:00:00Z'),
    });

    expect(entry.id).toBe('e1');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
});

const entry = (direction: LedgerDirection, money: string, before: string, after: string) =>
    WalletLedgerEntry.rehydrate({
        id: 'e1',
        walletId: 'w1',
        transactionId: 't1',
        direction,
        money: brl(money),
        balanceBefore: brl(before),
        balanceAfter: brl(after),
        createdAt: new Date('2026-10-28T12:00:00Z'),
    });

test('debit: 100 - 80 = 20 is balanced', () => {
    expect(entry(LedgerDirection.Debit, '80.00', '100.00', '20.00').isBalanced()).toBe(true);
});

test('credit: 100 + 25 = 125 is balanced', () => {
    expect(entry(LedgerDirection.Credit, '25.00', '100.00', '125.00').isBalanced()).toBe(true);
});

test('incorrect arithmetic is not balanced', () => {
    expect(entry(LedgerDirection.Debit, '80.00', '100.00', '30.00').isBalanced()).toBe(false);
});


const stateOf = (direction: LedgerDirection, money: string, before: string, after: string) => ({
  id: 'e1',
  walletId: 'w1',
  transactionId: 't1',
  direction,
  money: brl(money),
  balanceBefore: brl(before),
  balanceAfter: brl(after),
  createdAt: new Date('2026-10-28T12:00:00Z'),
});

test('create accepts balanced ledger entry', () => {
  const e = WalletLedgerEntry.create(stateOf(LedgerDirection.Debit, '80.00', '100.00', '20.00'));
  expect(e.isBalanced()).toBe(true);
});

test('create rejects incorrect arithmetic', () => {
  expect(() => WalletLedgerEntry.create(stateOf(LedgerDirection.Debit, '80.00', '100.00', '30.00'))).toThrow(
    InvalidLedgerEntryError,
  );
});

test('create rejects zero amount', () => {
  expect(() => WalletLedgerEntry.create(stateOf(LedgerDirection.Credit, '0.00', '100.00', '100.00'))).toThrow(
    InvalidLedgerEntryError,
  );
});

test('create rejects different currencies', () => {
  const mixed = {
    ...stateOf(LedgerDirection.Credit, '1.00', '100.00', '101.00'),
    money: Money.from({ amount: '1.00', currency: 'USD' }),
  };
  expect(() => WalletLedgerEntry.create(mixed)).toThrow(CurrencyMismatchError);
});