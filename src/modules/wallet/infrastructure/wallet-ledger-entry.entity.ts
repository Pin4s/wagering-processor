import { Check, Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Trigger, Unique } from '@mikro-orm/decorators/legacy';
import { WagerTransactionEntity } from '../../wagering/infrastructure/wager-transaction.entity';
import { LedgerDirection } from '../domain/wallet-ledger-entry';
import { WalletEntity } from './wallet.entity';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ name: 'wallet_ledger_entries_wallet_transaction_uq', properties: ['walletId', 'transactionId'] })
@Index({ name: 'wallet_ledger_entries_wallet_cursor_idx', properties: ['walletId', 'createdAt', 'id'] })
@Check({ name: 'wallet_ledger_entries_amount_positive', expression: 'amount_cents > 0' })
@Check({
  name: 'wallet_ledger_entries_balances_non_negative',
  expression: 'balance_before_cents >= 0 and balance_after_cents >= 0',
})
@Check({
  name: 'wallet_ledger_entries_balanced',
  expression: `(direction = 'CREDIT' and balance_after_cents = balance_before_cents + amount_cents)
            or (direction = 'DEBIT' and balance_after_cents = balance_before_cents - amount_cents)`,
})
@Trigger({
  name: 'wallet_ledger_entries_append_only',
  timing: 'before',
  events: ['update', 'delete'],
  body: "raise exception 'wallet_ledger_entries is append-only';",
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletEntity, { mapToPk: true, fieldName: 'wallet_id' })
  walletId!: string;

  @ManyToOne(() => WagerTransactionEntity, { mapToPk: true, fieldName: 'transaction_id' })
  transactionId!: string;

  @Enum({ items: () => LedgerDirection })
  direction!: LedgerDirection;

  @Property({ type: 'bigint' })
  amountCents!: bigint;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  @Property({ type: 'bigint' })
  balanceBeforeCents!: bigint;

  @Property({ type: 'bigint' })
  balanceAfterCents!: bigint;

  @Property({ type: 'timestamptz' })
  createdAt!: Date;
}