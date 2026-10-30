import { EntityManager, LockMode } from '@mikro-orm/core';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy, Optional } from '@nestjs/common';
import { MetricsRegistry } from '../../../shared/metrics/metrics.registry';
import { BackgroundLoopDiagnostics } from '../../../shared/background-loop-diagnostics';
import { newId } from '../../../shared/new-id';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { toNewOutboxMessageEntity } from '../../messaging/infrastructure/outbox-message.mapper';
import { WalletEntity } from '../../wallet/infrastructure/wallet.entity';
import { toWalletDomain, updateWalletEntity } from '../../wallet/infrastructure/wallet.mapper';
import { FailureCode } from '../domain/failure-code';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { WagerTransactionEntity } from '../infrastructure/wager-transaction.entity';
import { toWagerTransactionDomain, updateWagerTransactionEntity } from '../infrastructure/wager-transaction.mapper';
import { applyReversal, eventsFor, WalletNotFoundError } from './process-wager-transaction.use-case';

export const PENDING_REFERENCE_WORKER_OPTIONS = Symbol('PENDING_REFERENCE_WORKER_OPTIONS');

export interface PendingReferenceWorkerOptions {
  maxAttempts?: number;
  retryBaseSeconds?: number;
  pollIntervalMs?: number;
}

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private readonly diagnostics = new BackgroundLoopDiagnostics(this.logger, 'pending-reference-worker');
  private readonly maxAttempts: number;
  private readonly retryBaseSeconds: number;
  private readonly pollIntervalMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private loopStarted = false;
  private running = false;
  private stopping = false;
  private activeBatch?: Promise<number>;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(MetricsRegistry) private readonly metrics: MetricsRegistry,
    @Optional() @Inject(PENDING_REFERENCE_WORKER_OPTIONS) options: PendingReferenceWorkerOptions = {},
  ) {
    this.maxAttempts = configuredInteger(options.maxAttempts ?? Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 10), 10, 1);
    this.retryBaseSeconds = configuredInteger(options.retryBaseSeconds ?? Number(process.env.PENDING_REFERENCE_RETRY_BASE_SECONDS ?? 1), 1, 0);
    this.pollIntervalMs = configuredInteger(options.pollIntervalMs ?? Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 2_000), 2_000, 1);
  }

  async processDue(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      this.activeBatch = (async () => {
        const candidates = await this.em.fork().find(WagerTransactionEntity, {
          status: WagerTransactionStatus.PendingReference,
          $or: [{ nextReferenceCheckAt: null }, { nextReferenceCheckAt: { $lte: new Date() } }],
        }, { fields: ['id', 'walletId'], limit: 10, orderBy: { createdAt: 'asc', id: 'asc' } });
        let processed = 0;
        for (const candidate of candidates) {
          const result = await this.em.fork().transactional(async (em) => {
            const walletEntity = await em.findOne(WalletEntity, candidate.walletId, { lockMode: LockMode.PESSIMISTIC_WRITE });
            if (!walletEntity) {
              throw new WalletNotFoundError('wallet not found');
            }
            const row = await em.findOne(WagerTransactionEntity, candidate.id);
            const now = new Date();
            if (!row || row.status !== WagerTransactionStatus.PendingReference || (row.nextReferenceCheckAt && row.nextReferenceCheckAt > now)) {
              return;
            }
            const wallet = toWalletDomain(walletEntity);
            const transaction = toWagerTransactionDomain(row);
            const entry = await applyReversal(em, wallet, transaction);
            if (transaction.status === WagerTransactionStatus.PendingReference) {
              row.referenceAttempts++;
              if (row.referenceAttempts >= this.maxAttempts) {
                transaction.reject({ code: FailureCode.ReferenceNotFound, observedBalance: wallet.balance });
              } else {
                const delay = Math.min(300, this.retryBaseSeconds * 2 ** Math.min(row.referenceAttempts - 1, 30));
                row.nextReferenceCheckAt = new Date(now.getTime() + delay * 1_000);
              }
            }
            updateWagerTransactionEntity(row, transaction);
            updateWalletEntity(walletEntity, wallet);
            if (transaction.status !== WagerTransactionStatus.PendingReference) {
              row.nextReferenceCheckAt = undefined;
              const context = { correlationId: newId(), causationId: transaction.id };
              for (const event of eventsFor(transaction, wallet, entry, context)) {
                em.persist(toNewOutboxMessageEntity(OutboxMessage.enqueue(event)));
              }
            }
            return {
              transactionId: row.id, walletId: row.walletId, providerId: row.providerId,
              attempts: row.referenceAttempts, status: transaction.status, kind: transaction.kind,
            };
          });
          if (result) {
            processed++;
            if (result.status !== WagerTransactionStatus.PendingReference) {
              this.metrics.increment('wager_transactions_total', { status: result.status, kind: result.kind, source: 'worker' });
            }
            this.logger.log({ message: 'pending reference checked', ...result });
          }
        }
        return processed;
      })();
      return await this.activeBatch;
    } finally {
      this.running = false;
      this.activeBatch = undefined;
    }
  }

  onApplicationBootstrap(): void {
    if (process.env.PENDING_REFERENCE_WORKER_ENABLED === 'false' || this.loopStarted) {
      return;
    }
    this.stopping = false;
    this.loopStarted = true;
    void this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    await this.onApplicationShutdown();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      await this.activeBatch;
    } catch {
    }
    this.loopStarted = false;
  }

  private async poll(): Promise<void> {
    if (this.stopping || this.running) {
      if (!this.stopping) {
        this.scheduleNext(this.pollIntervalMs);
      }
      return;
    }
    let nextDelay = this.pollIntervalMs;
    try {
      await this.processDue();
      if (!this.stopping) {
        this.diagnostics.succeeded();
      }
    } catch (error) {
      if (!this.stopping) {
        nextDelay = this.diagnostics.failed(error);
      }
    } finally {
      if (!this.stopping) {
        this.scheduleNext(nextDelay);
      }
    }
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, delayMs);
  }
}

function configuredInteger(value: number, fallback: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    return fallback;
  }
  return value;
}
