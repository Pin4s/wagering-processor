import { PrimaryKeyProp } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  [PrimaryKeyProp]?: ['consumerName', 'messageId'];

  @PrimaryKey({ type: 'string' })
  consumerName!: string;

  @PrimaryKey({ type: 'string' })
  messageId!: string;

  @Property({ columnType: 'char(64)' })
  payloadHash!: string;

  @Property({ type: 'timestamptz' })
  receivedAt!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  processedAt?: Date;
}
