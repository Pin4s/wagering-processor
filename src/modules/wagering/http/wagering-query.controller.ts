import { BadRequestException, Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { isUuid } from '../../../shared/is-uuid';
import { TransactionNotFoundError, WagerTransactionQueriesService } from '../application/wager-transaction-queries.service';

@Controller()
export class WageringQueryController {
  constructor(@Inject(WagerTransactionQueriesService) private readonly queries: WagerTransactionQueriesService) {}

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    if (!isUuid(transactionId)) {
      throw new BadRequestException({ error: 'INVALID_PAYLOAD', message: 'transactionId must be a UUID' });
    }
    try {
      return await this.queries.getById(transactionId);
    } catch (error) {
      throw toHttpError(error);
    }
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    try {
      return await this.queries.getByExternalId(providerId, externalTransactionId);
    } catch (error) {
      throw toHttpError(error);
    }
  }
}

function toHttpError(error: unknown): unknown {
  if (error instanceof TransactionNotFoundError) {
    return new NotFoundException({ error: 'TRANSACTION_NOT_FOUND', message: error.message });
  }
  return error;
}
