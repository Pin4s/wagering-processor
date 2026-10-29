import { Migration } from '@mikro-orm/migrations';

export class Migration20261029232851 extends Migration {

  override name = 'Migration20261029232851';

  override up(): void | Promise<void> {
    this.addSql(`create table "outbox_messages" ("id" uuid not null, "aggregate_id" uuid not null, "event_type" varchar(255) not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null, "next_attempt_at" timestamptz null, "published_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "outbox_messages_pending_idx" on "outbox_messages" ("occurred_at") where published_at is null;`);

    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_attempts_non_negative" check (attempts >= 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
  }

}
