import { InvalidWalletError, Wallet } from './wallet';
import { expect, test } from 'bun:test';
import { Money } from '../../../shared/domain/money';

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