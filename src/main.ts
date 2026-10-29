import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonLogger } from './shared/json-logger';

async function bootstrap() {
    const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });

    app.enableShutdownHooks();
    await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
