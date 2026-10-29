import { EntityManager } from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import { WagerTransactionEntity } from '../infrastructure/wager-transaction.entity';
import { toWagerTransactionView } from '../infrastructure/wager-transaction.mapper';

export class TransactionNotFoundError extends Error {}

@Injectable()
export class WagerTransactionQueriesService {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async getById(transactionId: string) {
    const transaction = await this.em.fork().findOne(WagerTransactionEntity, { id: transactionId });
    return this.toView(transaction);
  }

  async getByExternalId(providerId: string, externalTransactionId: string) {
    const transaction = await this.em.fork().findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    return this.toView(transaction);
  }

  private toView(transaction: WagerTransactionEntity | null) {
    if (!transaction) {
      throw new TransactionNotFoundError('transaction not found');
    }
    return toWagerTransactionView(transaction);
  }
}
