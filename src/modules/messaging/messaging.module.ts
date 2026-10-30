import { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { SqsQueuesService } from './infrastructure/sqs-queues.service';

@Module({
  providers: [
    {
      provide: SQSClient,
      useFactory: () => new SQSClient({
        region: process.env.AWS_REGION,
        endpoint: process.env.SQS_ENDPOINT,
      }),
    },
    SqsQueuesService,
  ],
  exports: [SQSClient, SqsQueuesService],
})
export class MessagingModule {}
