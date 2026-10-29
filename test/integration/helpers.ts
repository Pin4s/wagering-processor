import { MikroORM } from '@mikro-orm/postgresql';
import { LedgerDirection } from '../../src/modules/wallet/domain/wallet-ledger-entry';
import { WalletLedgerEntryEntity } from '../../src/modules/wallet/infrastructure/wallet-ledger-entry.entity';

export async function truncateAll(orm: MikroORM): Promise<void> {
  await orm.em
    .getConnection()
    .execute('truncate table wallet_ledger_entries, wager_transactions, wallets cascade');
}

export function balanceFromLedger(entries: WalletLedgerEntryEntity[]): bigint {
  let total = 0n;
  for (const entry of entries) {
    if (entry.direction === LedgerDirection.Credit) {
      total = total + entry.amountCents;
    } else {
      total = total - entry.amountCents;
    }
  }
  return total;
}