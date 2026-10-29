import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config';

const command = process.argv[2];
const orm = await MikroORM.init(config);

if (command === 'up') {
    await orm.migrator.up();
} else if (command === 'down') {
    await orm.migrator.down();
} else if (command === 'create') {
    const result = await orm.migrator.create();
    console.log('created:', result.fileName);
} else {
    console.error('usage: bun run src/migrate.ts up|down|create');
    process.exitCode = 1;
}

await orm.close();