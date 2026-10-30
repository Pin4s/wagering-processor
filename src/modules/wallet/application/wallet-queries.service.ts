import { EntityManager, LockMode, raw, type FilterQuery } from '@mikro-orm/core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Money } from '../../../shared/domain/money';
import { MetricsRegistry } from '../../../shared/metrics/metrics.registry';
import { WalletNotFoundError } from '../../wagering/application/process-wager-transaction.use-case';
import { WalletEntity } from '../infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../infrastructure/wallet-ledger-entry.entity';
import { toLedgerEntryView } from '../infrastructure/wallet-ledger-entry.mapper';
import { toWalletView } from '../infrastructure/wallet.mapper';

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

interface LedgerTotals {
  balance_cents: string;
  checked_entries: string;
}

@Injectable()
export class WalletQueriesService {
  private readonly logger = new Logger(WalletQueriesService.name);

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(MetricsRegistry) private readonly metrics: MetricsRegistry = new MetricsRegistry(),
  ) { }

  async getWallet(walletId: string) {
    const wallet = await this.findWallet(this.em.fork(), walletId);
    return toWalletView(wallet);
  }

  async getLedger(walletId: string, limit: number, cursor?: LedgerCursor) {
    const em = this.em.fork();
    await this.findWallet(em, walletId);
    const where: FilterQuery<WalletLedgerEntryEntity> = { walletId };
    if (cursor) {
      where.$and = [
        { [raw('(created_at, id) > (?, ?)', [cursor.createdAt, cursor.id])]: [] },
      ];
    }
    const entries = await em.find(WalletLedgerEntryEntity, where, {
      orderBy: { createdAt: 'asc', id: 'asc' },
      limit: limit + 1,
    });
    const items = entries.slice(0, limit).map(toLedgerEntryView);
    let nextCursor: string | null = null;
    const lastItem = items.at(-1);
    if (entries.length > limit && lastItem) {
      nextCursor = Buffer.from(JSON.stringify({ createdAt: lastItem.createdAt, id: lastItem.id })).toString('base64url');
    }
    return { items, nextCursor };
  }

  async reconcile(walletId: string) {
    return this.em.fork().transactional(async (em) => {
      const wallet = await em.findOne(WalletEntity, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_READ });
      if (!wallet) {
        throw new WalletNotFoundError('wallet not found');
      }

      const totals: LedgerTotals[] = await em.getConnection().execute(
        `select coalesce(sum(case when direction = 'CREDIT' then amount_cents else -amount_cents end), 0)::text as balance_cents,
                count(*)::text as checked_entries
         from wallet_ledger_entries where wallet_id = ?`,
        [walletId],
        'all',
        em.getTransactionContext(),
      );
      const total = totals[0];
      if (!total) {
        throw new Error('ledger aggregation returned no result');
      }
      const storedBalance = Money.fromCents(wallet.balanceCents, wallet.currency);
      const calculatedBalance = Money.fromCents(BigInt(total.balance_cents), wallet.currency);
      const difference = storedBalance.subtract(calculatedBalance);
      const consistent = difference.isZero();
      if (!consistent) {
        this.metrics.increment('reconciliation_divergences_total');
        this.logger.warn({ message: 'wallet reconciliation divergence', walletId, difference: difference.toJSON() });
      }
      return {
        walletId,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: Number(total.checked_entries),
      };
    });
  }

  private async findWallet(em: EntityManager, walletId: string): Promise<WalletEntity> {
    const wallet = await em.findOne(WalletEntity, { id: walletId });
    if (!wallet) {
      throw new WalletNotFoundError('wallet not found');
    }
    return wallet;
  }
}
