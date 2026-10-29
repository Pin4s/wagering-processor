import { Migration } from '@mikro-orm/migrations';

export class Migration20261029202015 extends Migration {

  override name = 'Migration20261029202015';

  override up(): void | Promise<void> {
    this.addSql(`drop index "wager_transactions_one_reversal_uq";`);
    this.addSql(`create unique index "wager_transactions_one_reversal_per_reference_uq" on "wager_transactions" ("reference_transaction_id") where kind in ('REFUND', 'ROLLBACK');`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "wager_transactions_one_reversal_per_reference_uq";`);
    this.addSql(`create unique index "wager_transactions_one_reversal_uq" on "wager_transactions" ("reference_transaction_id", "kind") where kind = ANY (ARRAY['REFUND'::text, 'ROLLBACK'::text]);`);
  }

}
