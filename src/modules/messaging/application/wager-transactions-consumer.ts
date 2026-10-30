import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import { InvalidMoneyError } from '../../../shared/domain/money';
import { BackgroundLoopDiagnostics } from '../../../shared/background-loop-diagnostics';
import { isTransientInfrastructureError } from '../../../shared/is-transient-infrastructure-error';
import { MetricsRegistry } from '../../../shared/metrics/metrics.registry';
import {
  InvalidWagerTransactionRequestError,
  isNonEmptyString,
  parseWagerTransactionRequest,
} from '../../wagering/application/parse-wager-transaction-request';
import {
  IdempotencyConflictError,
  ProcessWagerTransactionUseCase,
  WAGER_TRANSACTIONS_CONSUMER_NAME,
  WalletMismatchError,
  WalletNotFoundError,
} from '../../wagering/application/process-wager-transaction.use-case';
import { InvalidWagerTransactionError } from '../../wagering/domain/wager-transaction';
import { SqsQueuesService } from '../infrastructure/sqs-queues.service';

export type ConsumerDecision = 'ack' | 'retry' | 'dlq';

interface MessageContext {
  messageId: string;
  correlationId: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

@Injectable()
export class WagerTransactionsConsumer implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(WagerTransactionsConsumer.name);
  private readonly diagnostics = new BackgroundLoopDiagnostics(this.logger, 'consumer');
  private stopping = false;
  private activePoll?: Promise<number>;
  private loopTask?: Promise<void>;
  private receiveAbort?: AbortController;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private wakeIdle?: () => void;

  constructor(
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(SqsQueuesService) private readonly queues: SqsQueuesService,
    @Inject(ProcessWagerTransactionUseCase) private readonly processTransaction: ProcessWagerTransactionUseCase,
    @Inject(MetricsRegistry) private readonly metrics: MetricsRegistry = new MetricsRegistry(),
  ) {}

  async handle(sqsMessage: Message): Promise<ConsumerDecision> {
    const context: MessageContext = {
      messageId: sqsMessage.MessageId ?? 'unknown',
      correlationId: sqsMessage.MessageId ?? 'unknown',
    };
    try {
      const envelope = parseEnvelope(sqsMessage.Body ?? '');
      if (isRecord(envelope) && isNonEmptyString(envelope.messageId)) {
        context.messageId = envelope.messageId;
        context.correlationId = envelope.messageId;
      }
      if (
        !isRecord(envelope) || envelope.type !== 'WagerTransactionRequested' ||
        !isNonEmptyString(envelope.messageId) || !isRecord(envelope.data)
      ) {
        throw new InvalidWagerTransactionRequestError('invalid wager transaction envelope');
      }
      const input = parseWagerTransactionRequest(envelope.data.idempotencyKey, envelope.data);
      context.walletId = input.walletId;
      context.providerId = input.providerId;
      const result = await this.processTransaction.execute({
        ...input,
        inbox: { consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME, messageId: envelope.messageId },
        causationId: envelope.messageId,
        correlationId: envelope.messageId,
      });
      context.transactionId = result.transactionId;
      this.recordDecision('ack');
      this.logger.log({ message: 'wager message handled', ...context, decision: 'ack' });
      return 'ack';
    } catch (error) {
      let decision: ConsumerDecision;
      if (
        error instanceof InvalidWagerTransactionRequestError ||
        error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError
      ) {
        decision = 'dlq';
      } else if (
        error instanceof WalletNotFoundError || error instanceof WalletMismatchError ||
        error instanceof IdempotencyConflictError
      ) {
        decision = 'ack';
      } else if (isTransientInfrastructureError(error)) {
        decision = 'retry';
      } else {
        decision = 'retry';
      }
      this.recordDecision(decision);
      this.logger.warn({ message: 'wager message handled', ...context, decision, errorName: errorName(error) });
      return decision;
    }
  }

  async applyDecision(sqsMessage: Message, decision: ConsumerDecision): Promise<void> {
    const queueUrl = await this.queues.getTransactionsQueueUrl();
    const receiptHandle = sqsMessage.ReceiptHandle;
    if (!receiptHandle) {
      throw new Error('SQS message requires a receipt handle');
    }
    if (decision === 'retry') {
      let base = Number(process.env.CONSUMER_RETRY_BASE_SECONDS ?? 2);
      if (!Number.isInteger(base) || base < 0) {
        base = 2;
      }
      let receiveCount = Number(sqsMessage.Attributes?.ApproximateReceiveCount ?? 1);
      if (!Number.isInteger(receiveCount) || receiveCount < 1) {
        receiveCount = 1;
      }
      const delay = Math.min(300, base * 2 ** Math.min(receiveCount - 1, 30));
      await this.sqs.send(new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: delay,
      }), { abortSignal: AbortSignal.timeout(5_000) });
    } else {
      if (decision === 'dlq') {
        if (!sqsMessage.MessageId || sqsMessage.Body === undefined) {
          throw new Error('SQS message requires an ID and body for DLQ delivery');
        }
        await this.sqs.send(new SendMessageCommand({
          QueueUrl: await this.queues.getTransactionsDlqUrl(),
          MessageBody: sqsMessage.Body,
          MessageGroupId: sqsMessage.Attributes?.MessageGroupId ?? 'invalid',
          MessageDeduplicationId: sqsMessage.MessageId,
        }), { abortSignal: AbortSignal.timeout(5_000) });
      }
      await this.sqs.send(new DeleteMessageCommand({
        QueueUrl: queueUrl, ReceiptHandle: receiptHandle,
      }), { abortSignal: AbortSignal.timeout(5_000) });
    }
  }

  private recordDecision(decision: ConsumerDecision): void {
    this.metrics.increment('consumer_messages_total', { decision });
    if (decision === 'retry') {
      this.metrics.increment('consumer_retries_total');
    }
  }

  async pollOnce(): Promise<number> {
    if (this.stopping || this.activePoll) {
      return 0;
    }
    try {
      this.activePoll = this.receiveAndProcess();
      return await this.activePoll;
    } finally {
      this.activePoll = undefined;
    }
  }

  onApplicationBootstrap(): void {
    if (process.env.SQS_CONSUMER_ENABLED === 'false' || this.loopTask) {
      return;
    }
    this.stopping = false;
    this.loopTask = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    await this.onApplicationShutdown();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.receiveAbort?.abort();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.wakeIdle?.();
    this.wakeIdle = undefined;
    await this.loopTask;
    await this.activePoll;
  }

  private async receiveAndProcess(): Promise<number> {
    const queueUrl = await this.queues.getTransactionsQueueUrl();
    if (this.stopping) {
      return 0;
    }
    const controller = new AbortController();
    this.receiveAbort = controller;
    let messages: Message[];
    try {
      const response = await this.sqs.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }), { abortSignal: controller.signal });
      messages = response.Messages ?? [];
    } catch (error) {
      if (this.stopping && controller.signal.aborted) {
        return 0;
      }
      throw error;
    } finally {
      this.receiveAbort = undefined;
    }
    let started = 0;
    try {
      for (const message of messages) {
        if (this.stopping) {
          break;
        }
        started++;
        const decision = await this.handle(message);
        await this.applyDecision(message, decision);
      }
      return started;
    } finally {
      await Promise.all(messages.slice(started).map(async (message) => {
        try {
          await this.sqs.send(new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0,
          }), { abortSignal: AbortSignal.timeout(5_000) });
        } catch (error) {
          this.logger.warn({
            message: 'unstarted wager message release failed',
            messageId: message.MessageId ?? 'unknown',
            correlationId: message.MessageId ?? 'unknown',
            decision: 'retry',
            errorName: errorName(error),
          });
        }
      }));
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        const count = await this.pollOnce();
        if (!this.stopping) {
          this.diagnostics.succeeded();
        }
        if (count === 0 && !this.stopping) {
          await this.pause(100);
        }
      } catch (error) {
        if (!this.stopping) {
          const nextRetryInMs = this.diagnostics.failed(error);
          await this.pause(nextRetryInMs);
        }
      }
    }
  }

  private pause(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.wakeIdle = resolve;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = undefined;
        this.wakeIdle = undefined;
        resolve();
      }, delayMs);
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnvelope(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new InvalidWagerTransactionRequestError('invalid JSON');
  }
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.constructor.name;
  }
  return 'UnknownError';
}
