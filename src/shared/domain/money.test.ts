import { describe, expect, test } from 'bun:test';
import { InvalidMoneyError, Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('25.5 turn 25.50', () => {
    expect(brl('25.5')
    .toJSON())
    .toEqual({ amount: '25.50', currency: 'BRL' });
  });

  test('reject invalid values', () => {
    for (const bad of ['', 'NaN', 'Infinity', '1e3', '-1.00', '1.234', 'abc', ' 1.00', '1,00', '.50']) {
      expect(() => brl(bad))
      .toThrow(InvalidMoneyError);
    }
  });

  test('reject number in place of strings', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' }))
    .toThrow(InvalidMoneyError);
  });
});