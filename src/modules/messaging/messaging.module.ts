import { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { SqsQueuesService } from './infrastructure/sqs-queues.service';
import { OutboxPublisher } from './application/outbox-publisher';
import { WagerTransactionsConsumer } from './application/wager-transactions-consumer';
import { WageringModule } from '../wagering/wagering.module';

@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: SQSClient,
      useFactory: () => new SQSClient({
        region: process.env.AWS_REGION,
        endpoint: process.env.SQS_ENDPOINT,
      }),
    },
    SqsQueuesService,
    OutboxPublisher,
    WagerTransactionsConsumer,
  ],
  exports: [SQSClient, SqsQueuesService, OutboxPublisher, WagerTransactionsConsumer],
})
export class MessagingModule {}
