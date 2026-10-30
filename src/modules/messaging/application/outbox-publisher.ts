import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager, LockMode } from '@mikro-orm/core';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { OutboxMessageEntity } from '../infrastructure/outbox-message.entity';
import { toOutboxMessageDomain, updateOutboxMessageEntity } from '../infrastructure/outbox-message.mapper';
import { SqsQueuesService } from '../infrastructure/sqs-queues.service';

export const OUTBOX_EVENTS_QUEUE_URL = Symbol('OUTBOX_EVENTS_QUEUE_URL');

@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopping = false;
  private activeBatch?: Promise<string[]>;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(SqsQueuesService) private readonly queues: SqsQueuesService,
    @Optional() @Inject(OUTBOX_EVENTS_QUEUE_URL) private readonly eventsQueueUrl?: string,
  ) {}

  async publishBatch(): Promise<string[]> {
    if (this.running) {
      return [];
    }
    this.running = true;
    try {
      this.activeBatch = this.em.fork().transactional(async (em) => {
        const now = new Date();
        const rows = await em.find(OutboxMessageEntity, {
          publishedAt: null,
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
        }, {
          limit: 10,
          orderBy: { occurredAt: 'asc' },
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        });
        const publishedIds: string[] = [];
        for (const row of rows) {
          const message = toOutboxMessageDomain(row);
          try {
            let queueUrl = this.eventsQueueUrl;
            if (!queueUrl) {
              queueUrl = await this.queues.getEventsQueueUrl();
            }
            await this.sqs.send(new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
            }), { abortSignal: AbortSignal.timeout(5_000) });
            message.markPublished(new Date());
            publishedIds.push(message.id);
          } catch (error) {
            message.scheduleRetry(new Date());
            this.logger.warn({
              message: 'outbox message publication failed',
              eventId: message.id,
              eventType: message.eventType,
              attempts: message.attempts,
              error: errorDetails(error),
            });
          }
          updateOutboxMessageEntity(row, message);
        }
        return publishedIds;
      });
      const publishedIds = await this.activeBatch;
      if (publishedIds.length > 0) {
        this.logger.log({ message: 'outbox messages published', eventIds: publishedIds });
      }
      return publishedIds;
    } finally {
      this.running = false;
      this.activeBatch = undefined;
    }
  }

  onApplicationBootstrap(): void {
    if (process.env.OUTBOX_PUBLISHER_ENABLED === 'false' || this.timer) {
      return;
    }
    let interval = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500);
    if (!Number.isInteger(interval) || interval <= 0) {
      interval = 500;
    }
    this.stopping = false;
    this.timer = setInterval(() => { void this.poll(); }, interval);
    void this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    await this.onApplicationShutdown();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.activeBatch;
  }

  private async poll(): Promise<void> {
    if (this.stopping || this.running) {
      return;
    }
    try {
      await this.publishBatch();
    } catch (error) {
      this.logger.error({ message: 'outbox publisher batch failed', error: errorDetails(error) });
    }
  }
}

function errorDetails(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  } else {
    return { name: 'UnknownError', message: String(error) };
  }
}
