import { Migration } from '@mikro-orm/migrations';

export class Migration20261030004812 extends Migration {

  override name = 'Migration20261030004812';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("consumer_name" varchar(255) not null, "message_id" varchar(255) not null, "payload_hash" char(64) not null, "received_at" timestamptz not null, "processed_at" timestamptz null, primary key ("consumer_name", "message_id"));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
  }

}
