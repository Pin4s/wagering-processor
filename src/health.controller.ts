import { EntityManager } from '@mikro-orm/core';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';

@Controller('health')
export class HealthController {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.em.getConnection().execute('select 1');
      return { status: 'ok', checks: { postgres: 'ok' } };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', checks: { postgres: 'down' } });
    }
  }
}
