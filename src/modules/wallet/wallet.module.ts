import { Module } from '@nestjs/common';
import { AuthGuard } from '../../shared/http/auth.guard';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { WalletController } from './http/wallet.controller';
import { WalletQueriesService } from './application/wallet-queries.service';

@Module({
  controllers: [WalletController],
  providers: [CreateWalletUseCase, WalletQueriesService, AuthGuard],
})
export class WalletModule {}
