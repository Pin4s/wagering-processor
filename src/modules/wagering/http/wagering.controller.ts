import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
} from '@mikro-orm/core';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpException,
  Inject,
  NotFoundException,
  Post,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InvalidMoneyError } from '../../../shared/domain/money';
import { isUuid } from '../../../shared/is-uuid';
import {
  IdempotencyConflictError,
  ProcessWagerTransactionInput,
  ProcessWagerTransactionUseCase,
  WalletMismatchError,
  WalletNotFoundError,
} from '../application/process-wager-transaction.use-case';
import { InvalidWagerTransactionError, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';

interface SubmitTransactionBody {
  providerId?: unknown;
  externalTransactionId?: unknown;
  playerId?: unknown;
  walletId?: unknown;
  roundId?: unknown;
  gameId?: unknown;
  kind?: unknown;
  money?: { amount?: unknown; currency?: unknown } | null;
  referenceExternalTransactionId?: unknown;
}

interface HttpResponse {
  status(code: number): unknown;
}

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processTransaction: ProcessWagerTransactionUseCase,
  ) { }

  @Post()
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: SubmitTransactionBody,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    if (!isNonEmptyString(idempotencyKey)) {
      throw new BadRequestException({ error: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required' });
    }
    const input = parseSubmitBody(idempotencyKey, body);

    try {
      const result = await this.processTransaction.execute(input);

      if (result.status === WagerTransactionStatus.Rejected) {
        throw new UnprocessableEntityException(result);
      }
      if (result.status === WagerTransactionStatus.PendingReference) {
        response.status(202);
      } else {
        response.status(200);
      }
      return result;
    } catch (error) {
      throw toHttpError(error);
    }
  }
}

function toHttpError(error: unknown): unknown {
  if (error instanceof HttpException) {
    return error;
  }
  if (error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError) {
    return invalidPayload(error.message);
  }
  if (error instanceof WalletNotFoundError) {
    return new NotFoundException({ error: 'WALLET_NOT_FOUND', message: error.message });
  }
  if (error instanceof WalletMismatchError) {
    return new UnprocessableEntityException({ error: 'WALLET_MISMATCH', message: error.message });
  }
  if (error instanceof IdempotencyConflictError) {
    return new ConflictException({ error: 'IDEMPOTENCY_CONFLICT', message: error.message });
  }
  if (isTransientInfrastructureError(error)) {
    return new ServiceUnavailableException({
      error: 'TEMPORARILY_UNAVAILABLE',
      message: 'temporary failure, retry with the same Idempotency-Key',
    });
  }
  return error;
}

function isTransientInfrastructureError(error: unknown): boolean {
  if (
    error instanceof ConnectionException ||
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException
  ) {
    return true;
  }
  if (error instanceof Error && 'code' in error) {
    const code = error.code;
    return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT';
  }
  return false;
}

function parseSubmitBody(idempotencyKey: string, body: SubmitTransactionBody): ProcessWagerTransactionInput {
  if (!isNonEmptyString(body.providerId)) {
    throw invalidPayload('providerId is required');
  }
  if (!isNonEmptyString(body.externalTransactionId)) {
    throw invalidPayload('externalTransactionId is required');
  }
  if (!isUuid(body.playerId)) {
    throw invalidPayload('playerId must be a UUID');
  }
  if (!isUuid(body.walletId)) {
    throw invalidPayload('walletId must be a UUID');
  }
  if (!isNonEmptyString(body.roundId)) {
    throw invalidPayload('roundId is required');
  }
  if (!isNonEmptyString(body.gameId)) {
    throw invalidPayload('gameId is required');
  }

  const kind = parseKind(body.kind);
  if (!kind) {
    throw invalidPayload('kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK');
  }

  const amount = body.money?.amount;
  const currency = body.money?.currency;
  if (typeof amount !== 'string' || typeof currency !== 'string') {
    throw invalidPayload('money must have amount and currency as strings');
  }

  let referenceExternalTransactionId: string | undefined = undefined;
  if (body.referenceExternalTransactionId !== undefined) {
    if (!isNonEmptyString(body.referenceExternalTransactionId)) {
      throw invalidPayload('referenceExternalTransactionId must be a non-empty string');
    }
    referenceExternalTransactionId = body.referenceExternalTransactionId;
  }

  return {
    idempotencyKey,
    providerId: body.providerId,
    externalTransactionId: body.externalTransactionId,
    playerId: body.playerId,
    walletId: body.walletId,
    roundId: body.roundId,
    gameId: body.gameId,
    kind,
    money: { amount, currency },
    referenceExternalTransactionId,
  };
}

function parseKind(value: unknown): WagerTransactionKind | undefined {
  if (value === 'BET') {
    return WagerTransactionKind.Bet;
  }
  if (value === 'WIN') {
    return WagerTransactionKind.Win;
  }
  if (value === 'LOSS') {
    return WagerTransactionKind.Loss;
  }
  if (value === 'REFUND') {
    return WagerTransactionKind.Refund;
  }
  if (value === 'ROLLBACK') {
    return WagerTransactionKind.Rollback;
  }
  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function invalidPayload(message: string): BadRequestException {
  return new BadRequestException({ error: 'INVALID_PAYLOAD', message });
}