import { Migration } from '@mikro-orm/migrations';

export class Migration20261029130117 extends Migration {

  override name = 'Migration20261029130117';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" uuid not null, "currency" char(3) not null, "balance_cents" bigint not null, "version" int not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_currency_uq" unique ("player_id", "currency");`);

    this.addSql(`alter table "wallets" add constraint "wallets_balance_non_negative" check (balance_cents >= 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallets" cascade;`);
  }

}
