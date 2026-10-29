import { expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../../shared/domain/money';
import { InvalidLedgerEntryError, LedgerDirection } from './wallet-ledger-entry';
import { InvalidWalletError, Wallet } from './wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

test('open creates wallet with initial balance', () => {
  const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('100.00') });
  expect(w.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  expect(w.currency).toBe('BRL');
  expect(w.version).toBe(1);
});

test('open accepts zero initial balance', () => {
  const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('0.00') });
  expect(w.balance.isZero()).toBe(true);
});

test('open rejects negative initial balance', () => {
  expect(() =>
    Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('1.00').negate() }),
  ).toThrow(InvalidWalletError);
});

test('rehydrate maintains version and balance information', () => {
  const w = Wallet.rehydrate({
    id: 'w1',
    playerId: 'p1',
    currency: 'BRL',
    balance: brl('50.00'),
    version: 7,
    createdAt: new Date('2026-10-28T12:00:00Z'),
    updatedAt: new Date('2026-10-28T12:30:00Z'),
  });
  expect(w.version).toBe(7);
  expect(w.balance.toJSON().amount).toBe('50.00');
});

const openWallet = (balance = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(balance) });

test('credit adds to balance, increments version and returns the ledger entry', () => {
  const w = openWallet();
  const entry = w.credit({ entryId: 'e1', transactionId: 't1', money: brl('25.00') });

  expect(w.balance.toJSON().amount).toBe('125.00');
  expect(w.version).toBe(2);
  expect(entry.direction).toBe(LedgerDirection.Credit);
  expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
  expect(entry.balanceAfter.toJSON().amount).toBe('125.00');
  expect(entry.isBalanced()).toBe(true);
});

test('credit with different currency fails and does not alter the wallet', () => {
  const w = openWallet();
  const usd = Money.from({ amount: '5.00', currency: 'USD' });

  expect(() => w.credit({ entryId: 'e1', transactionId: 't1', money: usd })).toThrow(CurrencyMismatchError);
  expect(w.balance.toJSON().amount).toBe('100.00');
  expect(w.version).toBe(1);
});

test('credit with zero amount fails and does not alter the wallet', () => {
  const w = openWallet();

  expect(() => w.credit({ entryId: 'e1', transactionId: 't1', money: brl('0.00') })).toThrow(
    InvalidLedgerEntryError,
  );
  expect(w.balance.toJSON().amount).toBe('100.00');
  expect(w.version).toBe(1);
});