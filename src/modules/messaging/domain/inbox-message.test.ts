import { expect, test } from 'bun:test';
import { InboxMessage } from './inbox-message';

const props = {
  messageId: 'message-1',
  consumerName: 'consumer-1',
  payloadHash: 'a'.repeat(64),
};

test('a received inbox message starts unprocessed and records its identity and receipt time', () => {
  const before = Date.now();
  const message = InboxMessage.receive(props);

  expect(message.messageId).toBe(props.messageId);
  expect(message.consumerName).toBe(props.consumerName);
  expect(message.payloadHash).toBe(props.payloadHash);
  expect(message.receivedAt.getTime()).toBeGreaterThanOrEqual(before);
  expect(message.receivedAt.getTime()).toBeLessThanOrEqual(Date.now());
  expect(message.processedAt).toBeUndefined();
  expect(message.isProcessed()).toBe(false);
});

test('markProcessed stores the processing time and preserves the supplied receipt time', () => {
  const receivedAt = new Date('2026-10-29T12:00:00Z');
  const processedAt = new Date('2026-10-29T12:00:01Z');
  const message = InboxMessage.receive({ ...props, receivedAt });

  message.markProcessed(processedAt);

  expect(message.receivedAt).toEqual(receivedAt);
  expect(message.processedAt).toEqual(processedAt);
  expect(message.isProcessed()).toBe(true);
});

test('rehydrate restores processed and unprocessed states without validation', () => {
  const state = {
    messageId: '',
    consumerName: '',
    payloadHash: 'legacy-hash',
    receivedAt: new Date('2026-10-29T12:00:00Z'),
    processedAt: new Date('2026-10-29T12:00:01Z'),
  };
  const processed = InboxMessage.rehydrate(state);

  expect(processed.messageId).toBe(state.messageId);
  expect(processed.consumerName).toBe(state.consumerName);
  expect(processed.payloadHash).toBe(state.payloadHash);
  expect(processed.receivedAt).toEqual(state.receivedAt);
  expect(processed.processedAt).toEqual(state.processedAt);
  expect(processed.isProcessed()).toBe(true);

  const unprocessed = InboxMessage.rehydrate({ ...state, processedAt: undefined });
  expect(unprocessed.processedAt).toBeUndefined();
  expect(unprocessed.isProcessed()).toBe(false);
});
