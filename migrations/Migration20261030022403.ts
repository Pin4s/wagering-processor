import { Migration } from '@mikro-orm/migrations';

export class Migration20261030022403 extends Migration {

  override name = 'Migration20261030022403';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add "reference_attempts" int not null default 0, add "next_reference_check_at" timestamptz null;`);
    this.addSql(`create index "wager_transactions_pending_reference_idx" on "wager_transactions" ("next_reference_check_at") where status = 'PENDING_REFERENCE';`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "wager_transactions_pending_reference_idx";`);
    this.addSql(`alter table "wager_transactions" drop column "reference_attempts", drop column "next_reference_check_at";`);
  }

}
