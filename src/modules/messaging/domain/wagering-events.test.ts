import { expect, test } from 'bun:test';
import { Money } from '../../../shared/domain/money';
import { Wallet } from '../../wallet/domain/wallet';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry';
import { WalletBalanceChanged } from './wagering-events';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

test('WalletBalanceChanged envelope has type, version and money as decimal strings', () => {
  const { wallet } = Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'tx-open',
    openingEntryId: 'e-open',
  });
  const entry = wallet.debit({ entryId: 'e1', transactionId: 't1', money: brl('25.00') });

  const envelope = WalletBalanceChanged.from(wallet, entry, { correlationId: 'corr-1' }).toJSON();

  expect(envelope.eventType).toBe('WalletBalanceChanged');
  expect(envelope.version).toBe(1);
  expect(envelope.aggregateId).toBe('w1');
  expect(envelope.correlationId).toBe('corr-1');
  expect(envelope.data.direction).toBe(LedgerDirection.Debit);
  expect(envelope.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
  expect(envelope.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
  expect(envelope.data.walletVersion).toBe(2);
  expect(typeof envelope.occurredAt).toBe('string');
});

test('event envelope survives JSON.stringify (no bigint inside)', () => {
  const { wallet } = Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'tx-open',
    openingEntryId: 'e-open',
  });
  const entry = wallet.credit({ entryId: 'e1', transactionId: 't1', money: brl('10.00') });
  const event = WalletBalanceChanged.from(wallet, entry, { correlationId: 'corr-1' });

  expect(() => JSON.stringify(event.toJSON())).not.toThrow();
});