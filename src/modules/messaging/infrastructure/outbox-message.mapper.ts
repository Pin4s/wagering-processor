import { OutboxMessage } from '../domain/outbox-message';
import { OutboxMessageEntity } from './outbox-message.entity';

export function toOutboxMessageDomain(entity: OutboxMessageEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
        id: entity.id,
        aggregateId: entity.aggregateId,
        eventType: entity.eventType,
        payload: entity.payload,
        occurredAt: entity.occurredAt,
        attempts: entity.attempts,
        nextAttemptAt: entity.nextAttemptAt ?? undefined,
        publishedAt: entity.publishedAt ?? undefined,
    });
}

export function toNewOutboxMessageEntity(message: OutboxMessage): OutboxMessageEntity {
    const entity = new OutboxMessageEntity();
    entity.id = message.id;
    entity.aggregateId = message.aggregateId;
    entity.eventType = message.eventType;
    entity.payload = message.payload;
    entity.occurredAt = message.occurredAt;
    updateOutboxMessageEntity(entity, message);
    return entity;
}

export function updateOutboxMessageEntity(entity: OutboxMessageEntity, message: OutboxMessage): void {
    entity.attempts = message.attempts;
    entity.nextAttemptAt = message.nextAttemptAt;
    entity.publishedAt = message.publishedAt;
}