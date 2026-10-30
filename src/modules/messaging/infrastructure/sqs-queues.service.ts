import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class SqsQueuesService implements OnModuleDestroy {
  private readonly urls = new Map<string, string>();
  private readonly transactionsQueue = process.env.SQS_WAGER_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo';
  private readonly transactionsDlq = process.env.SQS_WAGER_TRANSACTIONS_DLQ ?? 'wager-transactions-dlq.fifo';
  private readonly eventsQueue = process.env.SQS_EVENTS_QUEUE ?? 'wagering-events.fifo';

  constructor(@Inject(SQSClient) private readonly sqs: SQSClient) {}

  async getTransactionsQueueUrl(): Promise<string> {
    return this.getCachedQueueUrl(this.transactionsQueue);
  }

  async getTransactionsDlqUrl(): Promise<string> {
    return this.getCachedQueueUrl(this.transactionsDlq);
  }

  async getEventsQueueUrl(): Promise<string> {
    return this.getCachedQueueUrl(this.eventsQueue);
  }

  async checkReadiness(): Promise<void> {
    // A prontidão sempre consulta o SQS, mesmo quando a URL já está em cache.
    await this.resolveQueueUrl(this.transactionsQueue);
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }

  private async getCachedQueueUrl(queueName: string): Promise<string> {
    const cached = this.urls.get(queueName);
    if (cached) {
      return cached;
    }
    return this.resolveQueueUrl(queueName);
  }

  private async resolveQueueUrl(queueName: string): Promise<string> {
    const response = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName }), {
      abortSignal: AbortSignal.timeout(2_000),
    });
    if (!response.QueueUrl) {
      throw new Error(`SQS did not return a URL for queue ${queueName}`);
    }
    this.urls.set(queueName, response.QueueUrl);
    return response.QueueUrl;
  }
}
