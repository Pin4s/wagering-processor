import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/core';
import { Controller, Get, Header, Inject, Logger } from '@nestjs/common';
import { SqsQueuesService } from '../../modules/messaging/infrastructure/sqs-queues.service';
import { MetricsRegistry, type ScrapeGauges } from './metrics.registry';

interface OutboxGauges {
  pending: string;
  lag_seconds: number;
}

@Controller('metrics')
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);

  constructor(
    @Inject(MetricsRegistry) private readonly metrics: MetricsRegistry,
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(SqsQueuesService) private readonly queues: SqsQueuesService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async get(): Promise<string> {
    const [rows, dlqCount] = await Promise.all([
      this.em.getConnection().execute<OutboxGauges[]>(
        `select count(*)::text as pending,
                coalesce(greatest(extract(epoch from (clock_timestamp() - min(occurred_at))), 0), 0)::double precision as lag_seconds
         from outbox_messages where published_at is null`,
      ),
      this.readDlqCount(),
    ]);
    const outbox = rows[0];
    if (!outbox) {
      throw new Error('outbox aggregation returned no result');
    }
    const gauges: ScrapeGauges = {
      outbox_pending: Number(outbox.pending),
      outbox_lag_seconds: Number(outbox.lag_seconds),
    };
    if (dlqCount !== undefined) {
      gauges.sqs_dlq_messages = dlqCount;
    }
    return this.metrics.render(gauges);
  }

  private async readDlqCount(): Promise<number | undefined> {
    try {
      const response = await this.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: await this.queues.getTransactionsDlqUrl(),
        AttributeNames: ['ApproximateNumberOfMessages'],
      }), { abortSignal: AbortSignal.timeout(2_000) });
      const value = response.Attributes?.ApproximateNumberOfMessages;
      if (value === undefined || !Number.isFinite(Number(value)) || Number(value) < 0) {
        throw new Error('SQS did not return a valid DLQ message count');
      }
      return Number(value);
    } catch (error) {
      let errorName = 'UnknownError';
      if (error instanceof Error) {
        errorName = error.constructor.name;
      }
      this.logger.warn({ message: 'DLQ metric unavailable', errorName });
      return undefined;
    }
  }
}
