import { Check, Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })
@Index({
    name: 'outbox_messages_pending_idx',
    expression: `create index "outbox_messages_pending_idx" on "outbox_messages" ("occurred_at") where published_at is null`,
})
@Check({ name: 'outbox_messages_attempts_non_negative', expression: 'attempts >= 0' })
export class OutboxMessageEntity {
    @PrimaryKey({ type: 'uuid' })
    id!: string;  

    @Property({ type: 'uuid' })
    aggregateId!: string;

    @Property()
    eventType!: string;

    @Property({ type: 'json' })
    payload!: Record<string, unknown>;

    @Property({ type: 'timestamptz' })
    occurredAt!: Date;

    @Property()
    attempts!: number;

    @Property({ type: 'timestamptz', nullable: true })
    nextAttemptAt?: Date;

    @Property({ type: 'timestamptz', nullable: true })
    publishedAt?: Date;
}