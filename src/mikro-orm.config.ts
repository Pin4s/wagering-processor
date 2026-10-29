import { Migrator } from '@mikro-orm/migrations';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig } from '@mikro-orm/postgresql';
import { WalletEntity } from './modules/wallet/infrastructure/wallet.entity';
import { WagerTransactionEntity } from './modules/wagering/infrastructure/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './modules/wallet/infrastructure/wallet-ledger-entry.entity';
import { OutboxMessageEntity } from './modules/messaging/infrastructure/outbox-message.entity';

export default defineConfig({
  metadataProvider: ReflectMetadataProvider,
  clientUrl: process.env.DATABASE_URL,
  entities: [WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity, OutboxMessageEntity],
  extensions: [Migrator],
  migrations: { path: './migrations' },
});