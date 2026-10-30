import { Global, Module } from '@nestjs/common';
import { MetricsRegistry } from './metrics.registry';

@Global()
@Module({ providers: [MetricsRegistry], exports: [MetricsRegistry] })
export class MetricsModule {}
