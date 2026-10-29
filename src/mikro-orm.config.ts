import { Migrator } from '@mikro-orm/migrations';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig } from '@mikro-orm/postgresql';
import { WalletEntity } from './modules/wallet/infrastructure/wallet.entity';

export default defineConfig({
  metadataProvider: ReflectMetadataProvider,
  clientUrl: process.env.DATABASE_URL,
  entities: [WalletEntity],
  extensions: [Migrator],
  migrations: { path: './migrations' },
});