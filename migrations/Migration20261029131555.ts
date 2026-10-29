import { Migration } from '@mikro-orm/migrations';

export class Migration20261029131555 extends Migration {

  override name = 'Migration20261029131555';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" text not null, "amount_cents" bigint not null, "currency" char(3) not null, "balance_before_cents" bigint not null, "balance_after_cents" bigint not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "wallet_ledger_entries_wallet_cursor_idx" on "wallet_ledger_entries" ("wallet_id", "created_at", "id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_transaction_uq" unique ("wallet_id", "transaction_id");`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balanced" check ((direction = 'CREDIT' and balance_after_cents = balance_before_cents + amount_cents)
            or (direction = 'DEBIT' and balance_after_cents = balance_before_cents - amount_cents));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balances_non_negative" check (balance_before_cents >= 0 and balance_after_cents >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_amount_positive" check (amount_cents > 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_direction_check" check ("direction" in ('DEBIT', 'CREDIT'));`);
    this.addSql(`create or replace function "wallet_ledger_entries_wallet_ledger_entries_append_only_fn"() returns trigger as \$\$ begin raise exception 'wallet_ledger_entries is append-only'; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "wallet_ledger_entries_append_only" BEFORE UPDATE OR DELETE on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_wallet_ledger_entries_append_only_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop trigger if exists "wallet_ledger_entries_append_only" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_wallet_ledger_entries_append_only_fn"();`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }

}
