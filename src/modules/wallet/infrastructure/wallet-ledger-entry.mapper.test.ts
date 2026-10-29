import { expect, test } from 'bun:test';
import { Money } from '../../../shared/domain/money';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { toLedgerEntryDomain, toLedgerEntryEntity } from './wallet-ledger-entry.mapper';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

test('ledger entry survives a round trip domain -> entity -> domain', () => {
  const entry = WalletLedgerEntry.create({
    id: 'e1',
    walletId: 'w1',
    transactionId: 't1',
    direction: LedgerDirection.Debit,
    money: brl('80.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('20.00'),
    createdAt: new Date('2026-10-29T12:00:00Z'),
  });

  const entity = toLedgerEntryEntity(entry);
  expect(entity.amountCents).toBe(8000n);
  expect(entity.balanceAfterCents).toBe(2000n);
  expect(entity.currency).toBe('BRL');

  const back = toLedgerEntryDomain(entity);
  expect(back.direction).toBe(LedgerDirection.Debit);
  expect(back.balanceAfter.toJSON().amount).toBe('20.00');
  expect(back.isBalanced()).toBe(true);
});