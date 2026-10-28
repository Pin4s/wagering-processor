import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/core';                  
import type { EntityManager as PgEntityManager } from '@mikro-orm/postgresql';  
import { AppModule } from './app.module';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);

    
    const em = app.get(EntityManager) as PgEntityManager;
    const pool = await em.getConnection().getNativeClient();
    const res = await pool.query('select 1 as ok');
    console.log('DB OK:', res.rows);

    app.enableShutdownHooks();
    await app.listen(process.env.PORT ?? 3000);
}
bootstrap();