import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { SqsQueuesService } from '../../src/modules/messaging/infrastructure/sqs-queues.service';

let app: INestApplication;
let client: SQSClient;
let queues: SqsQueuesService;
let baseUrl: string;
let previousPublisherEnabled: string | undefined;
let previousConsumerEnabled: string | undefined;
let previousWorkerEnabled: string | undefined;

beforeAll(async () => {
  previousPublisherEnabled = process.env.OUTBOX_PUBLISHER_ENABLED;
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  previousConsumerEnabled = process.env.SQS_CONSUMER_ENABLED;
  process.env.SQS_CONSUMER_ENABLED = 'false';
  previousWorkerEnabled = process.env.PENDING_REFERENCE_WORKER_ENABLED;
  process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';
  app = await NestFactory.create(AppModule, { logger: false });
  client = app.get(SQSClient);
  queues = app.get(SqsQueuesService);
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  if (previousWorkerEnabled === undefined) {
    delete process.env.PENDING_REFERENCE_WORKER_ENABLED;
  } else {
    process.env.PENDING_REFERENCE_WORKER_ENABLED = previousWorkerEnabled;
  }
  if (previousConsumerEnabled === undefined) {
    delete process.env.SQS_CONSUMER_ENABLED;
  } else {
    process.env.SQS_CONSUMER_ENABLED = previousConsumerEnabled;
  }
  if (previousPublisherEnabled === undefined) {
    delete process.env.OUTBOX_PUBLISHER_ENABLED;
  } else {
    process.env.OUTBOX_PUBLISHER_ENABLED = previousPublisherEnabled;
  }
});

test('all three configured queues exist in LocalStack and are FIFO', async () => {
  const configuredQueues = [
    { name: process.env.SQS_WAGER_TRANSACTIONS_QUEUE, url: await queues.getTransactionsQueueUrl() },
    { name: process.env.SQS_WAGER_TRANSACTIONS_DLQ, url: await queues.getTransactionsDlqUrl() },
    { name: process.env.SQS_EVENTS_QUEUE, url: await queues.getEventsQueueUrl() },
  ];
  expect(new Set(configuredQueues.map((queue) => queue.url)).size).toBe(3);
  for (const queue of configuredQueues) {
    expect(queue.name).toBeDefined();
    const found = await client.send(new GetQueueUrlCommand({ QueueName: queue.name }));
    expect(found.QueueUrl).toBe(queue.url);
    const attributes = await client.send(new GetQueueAttributesCommand({
      QueueUrl: queue.url,
      AttributeNames: ['FifoQueue'],
    }));
    expect(attributes.Attributes?.FifoQueue).toBe('true');
  }
});

test('transaction queue has a 30 second visibility timeout and redrives to the DLQ after five receives', async () => {
  const transactionAttributes = await client.send(new GetQueueAttributesCommand({
    QueueUrl: await queues.getTransactionsQueueUrl(),
    AttributeNames: ['VisibilityTimeout', 'RedrivePolicy'],
  }));
  const dlqAttributes = await client.send(new GetQueueAttributesCommand({
    QueueUrl: await queues.getTransactionsDlqUrl(),
    AttributeNames: ['QueueArn'],
  }));

  expect(transactionAttributes.Attributes?.VisibilityTimeout).toBe('30');
  const policy = transactionAttributes.Attributes?.RedrivePolicy;
  const dlqArn = dlqAttributes.Attributes?.QueueArn;
  if (!policy || !dlqArn) {
    throw new Error('LocalStack must return the redrive policy and DLQ ARN');
  }
  expect(JSON.parse(policy)).toEqual({ deadLetterTargetArn: dlqArn, maxReceiveCount: 5 });
});

test('health readiness returns HTTP 200 with PostgreSQL and real SQS checks', async () => {
  const response = await fetch(`${baseUrl}/health/ready`);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', checks: { postgres: 'ok', sqs: 'ok' } });
});
