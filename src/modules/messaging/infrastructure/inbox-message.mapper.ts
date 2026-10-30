import { InboxMessage } from '../domain/inbox-message';
import { InboxMessageEntity } from './inbox-message.entity';

export function toInboxMessageDomain(entity: InboxMessageEntity): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: entity.messageId,
    consumerName: entity.consumerName,
    payloadHash: entity.payloadHash,
    receivedAt: entity.receivedAt,
    processedAt: entity.processedAt ?? undefined,
  });
}

export function toNewInboxMessageEntity(message: InboxMessage): InboxMessageEntity {
  const entity = new InboxMessageEntity();
  entity.messageId = message.messageId;
  entity.consumerName = message.consumerName;
  entity.payloadHash = message.payloadHash;
  entity.receivedAt = message.receivedAt;
  updateInboxMessageEntity(entity, message);
  return entity;
}

export function updateInboxMessageEntity(entity: InboxMessageEntity, message: InboxMessage): void {
  entity.processedAt = message.processedAt;
}
