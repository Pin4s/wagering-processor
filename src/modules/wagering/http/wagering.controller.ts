import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InvalidMoneyError } from '../../../shared/domain/money';
import { isTransientInfrastructureError } from '../../../shared/is-transient-infrastructure-error';
import { newId } from '../../../shared/new-id';
import {
  IdempotencyConflictError,
  ProcessWagerTransactionUseCase,
  WalletMismatchError,
  WalletNotFoundError,
} from '../application/process-wager-transaction.use-case';
import { InvalidWagerTransactionError, WagerTransactionStatus } from '../domain/wager-transaction';
import {
  InvalidWagerTransactionRequestError,
  isNonEmptyString,
  parseWagerTransactionRequest,
} from '../application/parse-wager-transaction-request';

interface HttpResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

@Controller('wagering/transactions')
export class WageringController {
  private readonly logger = new Logger(WageringController.name);

  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processTransaction: ProcessWagerTransactionUseCase,
  ) { }

  @Post()
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) response: HttpResponse,
    @Headers('x-correlation-id') correlationHeader: string | undefined,
  ) {
    let correlationId = correlationHeader;
    if (!correlationId) {
      correlationId = newId();
    }
    response.setHeader('X-Correlation-Id', correlationId);
    if (!isNonEmptyString(idempotencyKey)) {
      throw new BadRequestException({ error: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required' });
    }
    try {
      const input = parseWagerTransactionRequest(idempotencyKey, body);
      input.correlationId = correlationId;
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
      const httpError = toHttpError(error);
      if (httpError instanceof HttpException && httpError.getStatus() === 503) {
        let errorName = 'UnknownError';
        if (error instanceof Error) {
          errorName = error.constructor.name;
        }
        this.logger.error({ message: 'wager transaction temporarily unavailable', correlationId, errorName });
      }
      throw httpError;
    }
  }
}

function toHttpError(error: unknown): unknown {
  if (error instanceof HttpException) {
    return error;
  }
  if (
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWagerTransactionError ||
    error instanceof InvalidWagerTransactionRequestError
  ) {
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

function invalidPayload(message: string): BadRequestException {
  return new BadRequestException({ error: 'INVALID_PAYLOAD', message });
}
