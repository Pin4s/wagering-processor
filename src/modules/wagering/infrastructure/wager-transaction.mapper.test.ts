import { expect, test } from 'bun:test';
import { Money } from '../../../shared/domain/money';
import { FailureCode } from '../domain/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import {
  toNewWagerTransactionEntity,
  toWagerTransactionDomain,
  updateWagerTransactionEntity,
} from './wager-transaction.mapper';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const newBet = () =>
  WagerTransaction.create({
    id: 't1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
  });

test('processed transaction survives a round trip domain -> entity -> domain', () => {
  const tx = newBet();
  tx.markProcessed({ observedBalance: brl('975.00') });

  const entity = toNewWagerTransactionEntity(tx);
  expect(entity.amountCents).toBe(2500n);
  expect(entity.observedBalanceCents).toBe(97500n);
  expect(entity.status).toBe(WagerTransactionStatus.Processed);

  const back = toWagerTransactionDomain(entity);
  expect(back.status).toBe(WagerTransactionStatus.Processed);
  expect(back.money.toJSON().amount).toBe('25.00');
  expect(back.observedBalance?.toJSON().amount).toBe('975.00');
  expect(back.isTerminal()).toBe(true);
});

test('pending transaction has no observed balance after the round trip', () => {
  const entity = toNewWagerTransactionEntity(newBet());
  const back = toWagerTransactionDomain(entity);

  expect(back.status).toBe(WagerTransactionStatus.Pending);
  expect(back.observedBalance).toBeUndefined();
  expect(back.failureCode).toBeUndefined();
});

test('updateWagerTransactionEntity copies the result of a status change', () => {
  const tx = newBet();
  const entity = toNewWagerTransactionEntity(tx);

  tx.reject({ code: FailureCode.InsufficientFunds, observedBalance: brl('20.00') });
  updateWagerTransactionEntity(entity, tx);

  expect(entity.status).toBe(WagerTransactionStatus.Rejected);
  expect(entity.failureCode).toBe(FailureCode.InsufficientFunds);
  expect(entity.observedBalanceCents).toBe(2000n);
  expect(entity.processedAt).toBeInstanceOf(Date);
});