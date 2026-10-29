import { expect, test } from 'bun:test';
import { Money } from '../../../shared/domain/money';
import { Wallet } from '../../wallet/domain/wallet';
import { OutboxMessage } from './outbox-message';
import { WalletBalanceChanged } from './wagering-events';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function newMessage(): OutboxMessage {
  const { wallet } = Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'tx-open',
    openingEntryId: 'e-open',
  });
  const entry = wallet.credit({ entryId: 'e1', transactionId: 't1', money: brl('10.00') });
  return OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, { correlationId: 'c1' }));
}

test('a new outbox message is pending, has no attempts and is due right away', () => {
  const message = newMessage();
  expect(message.isPending()).toBe(true);
  expect(message.attempts).toBe(0);
  expect(message.isDue(new Date())).toBe(true);
  expect(message.eventType).toBe('WalletBalanceChanged');
});

test('scheduleRetry backs off exponentially and is capped at 5 minutes', () => {
  const message = newMessage();
  const now = new Date('2026-10-29T12:00:00Z');

  message.scheduleRetry(now);
  expect(message.attempts).toBe(1);
  expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 1_000);
  expect(message.isDue(now)).toBe(false);
  expect(message.isDue(new Date(now.getTime() + 1_000))).toBe(true);

  message.scheduleRetry(now);
  expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 2_000);

  for (let i = 0; i < 20; i++) {
    message.scheduleRetry(now);
  }
  expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 5 * 60 * 1_000);
});

test('a published message is no longer pending nor due', () => {
  const message = newMessage();
  message.markPublished(new Date());
  expect(message.isPending()).toBe(false);
  expect(message.isDue(new Date())).toBe(false);
});