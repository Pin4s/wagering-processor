import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { HealthController } from './health.controller';
import config from './mikro-orm.config';
import { WalletModule } from './modules/wallet/wallet.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { MetricsModule } from './shared/metrics/metrics.module';
import { MetricsController } from './shared/metrics/metrics.controller';

@Module({
  imports: [MetricsModule, MikroOrmModule.forRoot(config), WalletModule, WageringModule, MessagingModule],
  controllers: [HealthController, MetricsController],
})
export class AppModule { }
