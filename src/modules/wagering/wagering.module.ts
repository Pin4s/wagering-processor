import { Module } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { WageringController } from './http/wagering.controller';
import { WagerTransactionQueriesService } from './application/wager-transaction-queries.service';
import { WageringQueryController } from './http/wagering-query.controller';

@Module({
    controllers: [WageringController, WageringQueryController],
    providers: [ProcessWagerTransactionUseCase, WagerTransactionQueriesService],
    exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule { }
