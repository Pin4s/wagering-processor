import { expect, test } from 'bun:test';
import { Money } from '../../../shared/domain/money';
import { computePayloadHash, PayloadHashInput } from './payload-hash';
import { WagerTransactionKind } from './wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const input = (overrides: Partial<PayloadHashInput> = {}): PayloadHashInput => ({
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'r1',
  gameId: 'g1',
  kind: WagerTransactionKind.Bet,
  money: brl('25.00'),
  ...overrides,
});

test('the hash is a 64-character hexadecimal SHA-256 value', () => {
  expect(computePayloadHash(input())).toMatch(/^[0-9a-f]{64}$/);
});

test('the same content produces the same hash regardless of field order', () => {
  const a = input();
  const b: PayloadHashInput = {
    money: brl('25.00'),
    kind: WagerTransactionKind.Bet,
    gameId: 'g1',
    roundId: 'r1',
    walletId: 'w1',
    playerId: 'p1',
    externalTransactionId: 'ext-1',
    providerId: 'provider-a',
  };
  expect(computePayloadHash(a)).toBe(computePayloadHash(b));
});

test('"25" and "25.00" represent the same request', () => {
  expect(computePayloadHash(input({ money: brl('25') }))).toBe(computePayloadHash(input({ money: brl('25.00') })));
});

test('different content produces a different hash', () => {
  const base = computePayloadHash(input());
  expect(computePayloadHash(input({ money: brl('25.01') }))).not.toBe(base);
  expect(computePayloadHash(input({ roundId: 'r2' }))).not.toBe(base);
  expect(computePayloadHash(input({ kind: WagerTransactionKind.Win }))).not.toBe(base);
});
