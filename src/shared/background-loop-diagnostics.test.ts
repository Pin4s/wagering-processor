import { expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import { BackgroundLoopDiagnostics, backgroundLoopBackoffMs } from './background-loop-diagnostics';

test('consecutive loop failures back off exponentially and stop at 30 seconds', () => {
  expect(backgroundLoopBackoffMs(0)).toBe(0);
  expect([1, 2, 3, 4, 5, 6, 7, 20].map(backgroundLoopBackoffMs)).toEqual([
    1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
  ]);
});

test('recovery resets the failure count and logs once', () => {
  const logger = new Logger('test');
  const errors = spyOn(logger, 'error').mockImplementation(() => {});
  const infos = spyOn(logger, 'log').mockImplementation(() => {});
  const diagnostics = new BackgroundLoopDiagnostics(logger, 'consumer');
  const connectionError = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
  const aggregate = new AggregateError([connectionError]);

  expect(diagnostics.failed(aggregate)).toBe(1_000);
  expect(diagnostics.failed(aggregate)).toBe(2_000);
  expect(diagnostics.failed(aggregate)).toBe(4_000);
  expect(errors).toHaveBeenCalledTimes(2);
  expect(errors).toHaveBeenLastCalledWith({
    message: 'background loop failed, dependency unavailable?',
    loop: 'consumer',
    errorName: 'AggregateError',
    errorCode: 'ECONNREFUSED',
    consecutiveFailures: 2,
    nextRetryInMs: 2_000,
  });

  diagnostics.succeeded();
  diagnostics.succeeded();
  expect(infos).toHaveBeenCalledTimes(1);
  expect(infos).toHaveBeenCalledWith({
    message: 'background loop recovered', loop: 'consumer', afterFailures: 3,
  });
  expect(diagnostics.failed(aggregate)).toBe(1_000);
  expect(errors).toHaveBeenCalledTimes(3);
});

test('a different error type is logged between powers of two', () => {
  const logger = new Logger('test');
  const errors = spyOn(logger, 'error').mockImplementation(() => {});
  const diagnostics = new BackgroundLoopDiagnostics(logger, 'publisher');

  diagnostics.failed(new Error('first'));
  diagnostics.failed(new Error('second'));
  diagnostics.failed(new TypeError('changed'));
  expect(errors).toHaveBeenCalledTimes(3);
});
