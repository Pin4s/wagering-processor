import { expect, test } from 'bun:test';
import { MetricsRegistry } from './metrics.registry';

test('counters expose labels in a stable order and keep independent series', () => {
  const registry = new MetricsRegistry();
  registry.increment('wager_transactions_total', { source: 'http', kind: 'BET', status: 'PROCESSED' });
  registry.increment('wager_transactions_total', { status: 'PROCESSED', kind: 'BET', source: 'http' });
  registry.increment('wager_transactions_total', { status: 'REJECTED', kind: 'BET', source: 'sqs' });

  const text = registry.render();

  expect(text).toContain('# TYPE wager_transactions_total counter\n');
  expect(text).toContain('wager_transactions_total{status="PROCESSED",kind="BET",source="http"} 2\n');
  expect(text).toContain('wager_transactions_total{status="REJECTED",kind="BET",source="sqs"} 1\n');
  expect(text.endsWith('\n')).toBe(true);
  expect(text).not.toContain('\r');
});

test('histograms expose cumulative inclusive buckets, infinity, sum and count', () => {
  const registry = new MetricsRegistry();
  registry.observe('wager_processing_duration_seconds', 0.25);
  registry.observe('wager_processing_duration_seconds', 0.5);
  registry.observe('wager_processing_duration_seconds', 12);

  const text = registry.render();

  expect(text).toContain('# TYPE wager_processing_duration_seconds histogram\n');
  expect(text).toContain('wager_processing_duration_seconds_bucket{le="0.1"} 0\n');
  expect(text).toContain('wager_processing_duration_seconds_bucket{le="0.25"} 1\n');
  expect(text).toContain('wager_processing_duration_seconds_bucket{le="0.5"} 2\n');
  expect(text).toContain('wager_processing_duration_seconds_bucket{le="10"} 2\n');
  expect(text).toContain('wager_processing_duration_seconds_bucket{le="+Inf"} 3\n');
  expect(text).toContain('wager_processing_duration_seconds_sum 12.75\n');
  expect(text).toContain('wager_processing_duration_seconds_count 3\n');
  expect(text).toContain('wallet_lock_wait_seconds_count 0\n');
});

test('metric labels reject identifiers and observations reject invalid durations', () => {
  const registry = new MetricsRegistry();

  expect(() => registry.increment('duplicates_detected_total', { layer: 'message-123' })).toThrow();
  expect(() => registry.increment('duplicates_detected_total', { layer: 'inbox', messageId: 'message-123' })).toThrow();
  expect(() => registry.observe('wallet_lock_wait_seconds', -1)).toThrow();
  expect(() => registry.observe('wallet_lock_wait_seconds', Number.NaN)).toThrow();
  expect(() => registry.observe('wallet_lock_wait_seconds', Number.POSITIVE_INFINITY)).toThrow();
  expect(registry.render()).not.toContain('message-123');
});

test('scrape gauges are rendered per request without retaining an unavailable DLQ value', () => {
  const registry = new MetricsRegistry();

  expect(registry.render({ outbox_pending: 2, outbox_lag_seconds: 3, sqs_dlq_messages: 1 })).toContain('sqs_dlq_messages 1\n');
  const text = registry.render({ outbox_pending: 0, outbox_lag_seconds: 0 });
  expect(text).toContain('# TYPE outbox_pending gauge\noutbox_pending 0\n');
  expect(text).toContain('outbox_lag_seconds 0\n');
  expect(text).not.toContain('sqs_dlq_messages');
});
