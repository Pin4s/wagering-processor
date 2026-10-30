import { isUuid } from '../../../shared/is-uuid';
import { WagerTransactionKind } from '../domain/wager-transaction';
import type { ProcessWagerTransactionInput } from './process-wager-transaction.use-case';

export class InvalidWagerTransactionRequestError extends Error {}

export function parseWagerTransactionRequest(
  idempotencyKey: unknown,
  body: Record<string, unknown>,
): ProcessWagerTransactionInput {
  if (!isNonEmptyString(idempotencyKey)) {
    throw new InvalidWagerTransactionRequestError('idempotencyKey is required');
  }
  if (!isNonEmptyString(body.providerId)) {
    throw new InvalidWagerTransactionRequestError('providerId is required');
  }
  if (!isNonEmptyString(body.externalTransactionId)) {
    throw new InvalidWagerTransactionRequestError('externalTransactionId is required');
  }
  if (!isUuid(body.playerId)) {
    throw new InvalidWagerTransactionRequestError('playerId must be a UUID');
  }
  if (!isUuid(body.walletId)) {
    throw new InvalidWagerTransactionRequestError('walletId must be a UUID');
  }
  if (!isNonEmptyString(body.roundId)) {
    throw new InvalidWagerTransactionRequestError('roundId is required');
  }
  if (!isNonEmptyString(body.gameId)) {
    throw new InvalidWagerTransactionRequestError('gameId is required');
  }
  const kind = parseKind(body.kind);
  if (!kind) {
    throw new InvalidWagerTransactionRequestError('kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK');
  }
  const money = body.money;
  if (!isRecord(money) || typeof money.amount !== 'string' || typeof money.currency !== 'string') {
    throw new InvalidWagerTransactionRequestError('money must have amount and currency as strings');
  }
  let referenceExternalTransactionId: string | undefined;
  if (body.referenceExternalTransactionId !== undefined) {
    if (!isNonEmptyString(body.referenceExternalTransactionId)) {
      throw new InvalidWagerTransactionRequestError('referenceExternalTransactionId must be a non-empty string');
    }
    referenceExternalTransactionId = body.referenceExternalTransactionId;
  }
  return {
    idempotencyKey,
    providerId: body.providerId,
    externalTransactionId: body.externalTransactionId,
    playerId: body.playerId,
    walletId: body.walletId,
    roundId: body.roundId,
    gameId: body.gameId,
    kind,
    money: { amount: money.amount, currency: money.currency },
    referenceExternalTransactionId,
  };
}

function parseKind(value: unknown): WagerTransactionKind | undefined {
  if (value === 'BET') {
    return WagerTransactionKind.Bet;
  }
  if (value === 'WIN') {
    return WagerTransactionKind.Win;
  }
  if (value === 'LOSS') {
    return WagerTransactionKind.Loss;
  }
  if (value === 'REFUND') {
    return WagerTransactionKind.Refund;
  }
  if (value === 'ROLLBACK') {
    return WagerTransactionKind.Rollback;
  }
  return undefined;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
