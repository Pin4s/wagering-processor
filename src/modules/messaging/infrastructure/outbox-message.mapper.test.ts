import { expect, test } from 'bun:test';
import { Money } from '../../../shared/domain/money';
import { Wallet } from '../../wallet/domain/wallet';
import { OutboxMessage } from '../domain/outbox-message';
import { WalletBalanceChanged } from '../domain/wagering-events';
import { toNewOutboxMessageEntity, toOutboxMessageDomain, updateOutboxMessageEntity } from './outbox-message.mapper';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

test('outbox message survives a round trip and updates attempts/publication', () => {
  const { wallet } = Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'tx-open',
    openingEntryId: 'e-open',
  });
  const entry = wallet.credit({ entryId: 'e1', transactionId: 't1', money: brl('10.00') });
  const message = OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, { correlationId: 'c1' }));

  const entity = toNewOutboxMessageEntity(message);
  expect(entity.attempts).toBe(0);
  expect(entity.payload['eventType']).toBe('WalletBalanceChanged');

  const back = toOutboxMessageDomain(entity);
  expect(back.isPending()).toBe(true);

  back.scheduleRetry(new Date('2026-10-29T12:00:00Z'));
  updateOutboxMessageEntity(entity, back);
  expect(entity.attempts).toBe(1);
  expect(entity.nextAttemptAt).toBeInstanceOf(Date);
});