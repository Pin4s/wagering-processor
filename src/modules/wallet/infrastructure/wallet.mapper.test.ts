import { expect, test } from 'bun:test';
import { Money } from '../../../shared/domain/money';
import { Wallet } from '../domain/wallet';
import { toNewWalletEntity, toWalletDomain, updateWalletEntity } from './wallet.mapper';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

test('wallet survives a round trip domain -> entity -> domain', () => {
  const wallet = Wallet.open({
    id: 'w1', playerId: 'p1', initialBalance: brl('100.00'),
    openingTransactionId: 'tx-open', openingEntryId: 'e-open',
  }).wallet;
  wallet.debit({ entryId: 'e1', transactionId: 't1', money: brl('25.50') });

  const entity = toNewWalletEntity(wallet);
  expect(entity.balanceCents).toBe(7450n);
  expect(entity.version).toBe(2);

  const back = toWalletDomain(entity);
  expect(back.balance.toJSON()).toEqual({ amount: '74.50', currency: 'BRL' });
  expect(back.version).toBe(2);
  expect(back.playerId).toBe('p1');
});

test('updateWalletEntity changes balance, version and updatedAt on the same entity', () => {
  const wallet = Wallet.open({
    id: 'w1', playerId: 'p1', initialBalance: brl('100.00'),
    openingTransactionId: 'tx-open', openingEntryId: 'e-open',
  }).wallet;
  const entity = toNewWalletEntity(wallet);

  wallet.credit({ entryId: 'e1', transactionId: 't1', money: brl('10.00') });
  updateWalletEntity(entity, wallet);

  expect(entity.balanceCents).toBe(11000n);
  expect(entity.version).toBe(2);
  expect(entity.id).toBe('w1');
});
