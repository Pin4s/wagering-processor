import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { HealthController } from './health.controller';
import config from './mikro-orm.config';

@Module({
  imports: [MikroOrmModule.forRoot(config)],
  controllers: [HealthController],
})
export class AppModule {}