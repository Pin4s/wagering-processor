import { createHash } from 'node:crypto';
import { Money } from '../../../shared/domain/money';
import { WagerTransactionKind } from './wager-transaction';

export interface PayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export function computePayloadHash(input: PayloadHashInput): string {
  const canonical = JSON.stringify({
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money.toJSON(),
    playerId: input.playerId,
    providerId: input.providerId,
    referenceExternalTransactionId: input.referenceExternalTransactionId,
    roundId: input.roundId,
    walletId: input.walletId,
  });
  return createHash('sha256').update(canonical).digest('hex');
}