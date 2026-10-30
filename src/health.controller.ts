import { EntityManager } from '@mikro-orm/core';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SqsQueuesService } from './modules/messaging/infrastructure/sqs-queues.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SqsQueuesService) private readonly queues: SqsQueuesService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const [postgres, sqs] = await Promise.allSettled([
      this.em.getConnection().execute('select 1'),
      this.queues.checkReadiness(),
    ]);
    const checks = { postgres: 'down', sqs: 'down' };
    if (postgres.status === 'fulfilled') {
      checks.postgres = 'ok';
    }
    if (sqs.status === 'fulfilled') {
      checks.sqs = 'ok';
    }
    if (checks.postgres === 'ok' && checks.sqs === 'ok') {
      return { status: 'ok', checks };
    } else {
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }
  }
}
