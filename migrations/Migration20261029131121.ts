import { Migration } from '@mikro-orm/migrations';

export class Migration20261029131121 extends Migration {

  override name = 'Migration20261029131121';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(255) not null, "external_transaction_id" varchar(255) not null, "idempotency_key" varchar(255) not null, "payload_hash" char(64) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" varchar(255) not null, "game_id" varchar(255) not null, "kind" text not null, "amount_cents" bigint not null, "currency" char(3) not null, "reference_external_transaction_id" varchar(255) null, "reference_transaction_id" uuid null, "status" text not null, "failure_code" text null, "observed_balance_cents" bigint null, "processed_at" timestamptz null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create unique index "wager_transactions_one_reversal_uq" on "wager_transactions" ("reference_transaction_id", "kind") where kind in ('REFUND', 'ROLLBACK');`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_external_uq" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_idempotency_key_uq" unique ("idempotency_key");`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete set null;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_amount_non_negative" check (amount_cents >= 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_failure_code_check" check ("failure_code" in ('INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'WALLET_NOT_FOUND', 'WALLET_MISMATCH', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH', 'INVALID_REFERENCE_KIND', 'REFERENCE_NOT_PROCESSED', 'ALREADY_REVERSED', 'AMOUNT_MISMATCH', 'INTERNAL_ERROR'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_transaction_id_foreign";`);

    this.addSql(`drop table if exists "wager_transactions" cascade;`);
  }

}
