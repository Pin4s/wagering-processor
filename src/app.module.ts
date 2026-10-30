import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { HealthController } from './health.controller';
import config from './mikro-orm.config';
import { WalletModule } from './modules/wallet/wallet.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { MessagingModule } from './modules/messaging/messaging.module';

@Module({
  imports: [MikroOrmModule.forRoot(config), WalletModule, WageringModule, MessagingModule],
  controllers: [HealthController],
})
export class AppModule { }
