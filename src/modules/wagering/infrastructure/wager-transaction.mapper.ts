import { Money } from '../../../shared/domain/money';
import { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionEntity } from './wager-transaction.entity';

export function toWagerTransactionDomain(entity: WagerTransactionEntity): WagerTransaction {
  let observedBalance: Money | undefined = undefined;
  if (entity.observedBalanceCents !== undefined && entity.observedBalanceCents !== null) {
    observedBalance = Money.fromCents(entity.observedBalanceCents, entity.currency);
  }

  return WagerTransaction.rehydrate({
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash,
    walletId: entity.walletId,
    playerId: entity.playerId,
    roundId: entity.roundId,
    gameId: entity.gameId,
    kind: entity.kind,
    money: Money.fromCents(entity.amountCents, entity.currency),
    referenceExternalTransactionId: entity.referenceExternalTransactionId ?? undefined,
    status: entity.status,
    createdAt: entity.createdAt,
    referenceTransactionId: entity.referenceTransactionId ?? undefined,
    failureCode: entity.failureCode ?? undefined,
    processedAt: entity.processedAt ?? undefined,
    observedBalance,
  });
}

export function toNewWagerTransactionEntity(tx: WagerTransaction): WagerTransactionEntity {
  const entity = new WagerTransactionEntity();
  entity.id = tx.id;
  entity.providerId = tx.providerId;
  entity.externalTransactionId = tx.externalTransactionId;
  entity.idempotencyKey = tx.idempotencyKey;
  entity.payloadHash = tx.payloadHash;
  entity.walletId = tx.walletId;
  entity.playerId = tx.playerId;
  entity.roundId = tx.roundId;
  entity.gameId = tx.gameId;
  entity.kind = tx.kind;
  entity.amountCents = tx.money.toCents();
  entity.currency = tx.money.currency;
  entity.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  entity.createdAt = tx.createdAt;
  updateWagerTransactionEntity(entity, tx);
  return entity;
}

export function updateWagerTransactionEntity(entity: WagerTransactionEntity, tx: WagerTransaction): void {
  entity.status = tx.status;
  entity.referenceTransactionId = tx.referenceTransactionId;
  entity.failureCode = tx.failureCode;
  entity.processedAt = tx.processedAt;
  entity.observedBalanceCents = tx.observedBalance?.toCents();
}