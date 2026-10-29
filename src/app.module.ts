import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { HealthController } from './health.controller';
import config from './mikro-orm.config';
import { WalletModule } from './modules/wallet/wallet.module';

@Module({
  imports: [MikroOrmModule.forRoot(config), WalletModule],
  controllers: [HealthController],
})
export class AppModule {}