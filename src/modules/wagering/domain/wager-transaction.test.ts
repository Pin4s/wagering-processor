import { expect, test } from 'bun:test';
import { Money } from '../../../shared/domain/money';
import { FailureCode } from './failure-code';
import {
  CreateWagerTransactionProps,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const props = (overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: 't1',
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'provider-a:ext-1',
  payloadHash: 'hash',
  walletId: 'w1',
  playerId: 'p1',
  roundId: 'r1',
  gameId: 'g1',
  kind: WagerTransactionKind.Bet,
  money: brl('25.00'),
  ...overrides,
});

test('create starts as PENDING and is not terminal', () => {
  const tx = WagerTransaction.create(props());
  expect(tx.status).toBe(WagerTransactionStatus.Pending);
  expect(tx.isTerminal()).toBe(false);
});

test('REFUND and ROLLBACK require a reference and succeed with one', () => {
  for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
    expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidWagerTransactionError);
    const tx = WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'ext-0' }));
    expect(tx.requiresReference()).toBe(true);
  }
});

test('BET, WIN and LOSS do not require a reference', () => {
  for (const kind of [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss]) {
    expect(WagerTransaction.create(props({ kind })).requiresReference()).toBe(false);
  }
});

test('only LOSS does not affect the balance', () => {
  expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Loss })).affectsBalance()).toBe(false);
  expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Bet })).affectsBalance()).toBe(true);
  expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Win })).affectsBalance()).toBe(true);
});

test('zero value is only allowed for LOSS', () => {
  expect(() => WagerTransaction.create(props({ money: brl('0.00') }))).toThrow(InvalidWagerTransactionError);
  const loss = WagerTransaction.create(props({ kind: WagerTransactionKind.Loss, money: brl('0.00') }));
  expect(loss.money.isZero()).toBe(true);
});

test('rehydrate reconstructs a terminal transaction without validation', () => {
  const tx = WagerTransaction.rehydrate({
    ...props(),
    status: WagerTransactionStatus.Processed,
    createdAt: new Date('2026-10-28T12:00:00Z'),
  });
  expect(tx.status).toBe(WagerTransactionStatus.Processed);
  expect(tx.isTerminal()).toBe(true);
});

const at = new Date('2026-10-28T13:00:00Z');

test('markProcessed finalizes the transaction and stores the observed balance', () => {
  const tx = WagerTransaction.create(props());
  tx.markProcessed({ observedBalance: brl('975.00'), referenceTransactionId: 'tx-ref', at });

  expect(tx.status).toBe(WagerTransactionStatus.Processed);
  expect(tx.isTerminal()).toBe(true);
  expect(tx.observedBalance?.toJSON().amount).toBe('975.00');
  expect(tx.referenceTransactionId).toBe('tx-ref');
  expect(tx.processedAt).toEqual(at);
});

test('markPendingReference is not terminal and can be processed later', () => {
  const tx = WagerTransaction.create(
    props({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-0' }),
  );
  tx.markPendingReference();
  expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  expect(tx.isTerminal()).toBe(false);

  tx.markProcessed({ observedBalance: brl('100.00'), referenceTransactionId: 'tx-ref', at });
  expect(tx.status).toBe(WagerTransactionStatus.Processed);
});

test('reject stores the failure code and observed balance', () => {
  const tx = WagerTransaction.create(props());
  tx.reject({ code: FailureCode.InsufficientFunds, observedBalance: brl('20.00'), at });

  expect(tx.status).toBe(WagerTransactionStatus.Rejected);
  expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  expect(tx.observedBalance?.toJSON().amount).toBe('20.00');
  expect(tx.isTerminal()).toBe(true);
});

test('reject works from PENDING_REFERENCE when the reference never arrives', () => {
  const tx = WagerTransaction.create(
    props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }),
  );
  tx.markPendingReference();
  tx.reject({ code: FailureCode.ReferenceNotFound, observedBalance: brl('100.00'), at });

  expect(tx.status).toBe(WagerTransactionStatus.Rejected);
  expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
});

test('fail stores the failure code and makes the transaction terminal', () => {
  const tx = WagerTransaction.create(props());
  tx.fail(FailureCode.InternalError, at);

  expect(tx.status).toBe(WagerTransactionStatus.Failed);
  expect(tx.failureCode).toBe(FailureCode.InternalError);
  expect(tx.isTerminal()).toBe(true);
});

test('terminal states do not allow any transitions', () => {
  const finishers: Array<(tx: WagerTransaction) => void> = [
    (tx) => tx.markProcessed({ observedBalance: brl('1.00'), at }),
    (tx) => tx.reject({ code: FailureCode.InsufficientFunds, observedBalance: brl('1.00'), at }),
    (tx) => tx.fail(FailureCode.InternalError, at),
  ];
  const transitions: Array<(tx: WagerTransaction) => void> = [
    (tx) => tx.markProcessed({ observedBalance: brl('1.00'), at }),
    (tx) => tx.markPendingReference(),
    (tx) => tx.reject({ code: FailureCode.InsufficientFunds, observedBalance: brl('1.00'), at }),
    (tx) => tx.fail(FailureCode.InternalError, at),
  ];

  for (const finish of finishers) {
    for (const next of transitions) {
      const tx = WagerTransaction.create(props());
      finish(tx);
      expect(() => next(tx)).toThrow(InvalidTransactionStateError);
    }
  }
});
