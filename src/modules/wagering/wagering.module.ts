import { Module } from '@nestjs/common';
import { AuthGuard } from '../../shared/http/auth.guard';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { PendingReferenceWorker } from './application/pending-reference-worker';
import { WageringController } from './http/wagering.controller';
import { WagerTransactionQueriesService } from './application/wager-transaction-queries.service';
import { WageringQueryController } from './http/wagering-query.controller';

@Module({
    controllers: [WageringController, WageringQueryController],
    providers: [ProcessWagerTransactionUseCase, WagerTransactionQueriesService, PendingReferenceWorker, AuthGuard],
    exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule { }
