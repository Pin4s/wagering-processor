import { Module } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { WageringController } from './http/wagering.controller';

@Module({
    controllers: [WageringController],
    providers: [ProcessWagerTransactionUseCase],
})
export class WageringModule { }