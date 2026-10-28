import { expect, test } from 'bun:test';
import { Money } from './money';

test('25.5 turns 25.50', () => {
  const m = Money.from({ amount: '25.5', currency: 'BRL' });
  expect(m.toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
});