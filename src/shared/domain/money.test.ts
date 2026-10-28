import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from './money';

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

  test('reject invalid currency', () => {
    for (const bad of ['brl', 'BR', 'REAIS', '', 'B1L']) {
      expect(() => Money.from({ amount: '1.00', currency: bad })).toThrow(InvalidMoneyError);
    }
  });

  test('sum correctly money with same currency', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('add does not mutate the original money instance', () => {
    const a = brl('10.00');
    a.add(brl('5.00'));
    expect(a.toJSON().amount).toBe('10.00');
  });

  test('add money with different currency throws domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
  });

  test('subtract correctly money with same currency', () => {
    expect(brl('10.00').subtract(brl('3.50')).toJSON().amount).toBe('6.50');
  });

  test('subtract money with different currency throws domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
  });

  test('subtract with negative results', () => {
    expect(brl('10.00').subtract(brl('25.00')).toJSON().amount).toBe('-15.00');
    expect(brl('0.05').subtract(brl('0.10')).toJSON().amount).toBe('-0.05');
  });

});