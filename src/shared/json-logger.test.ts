import { expect, spyOn, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import { JsonLogger } from './json-logger';

test('writes each Nest log level as one JSON line on stdout', () => {
  const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
  const logger = new JsonLogger();
  try {
    logger.log({ message: 'finished\nnext line', correlationId: 'correlation-1' }, 'TestContext');
    logger.warn('warning', 'TestContext');
    logger.error(new TypeError('failed'), 'stack\ntrace', 'TestContext');
    logger.debug('debug', 'TestContext');
    logger.verbose('verbose', 'TestContext');
    logger.fatal('fatal', 'TestContext');

    expect(output).toHaveBeenCalledTimes(6);
    const levels: string[] = [];
    for (const [line] of output.mock.calls) {
      const text = String(line);
      expect(text.split('\n')).toHaveLength(2);
      const record = JSON.parse(text);
      levels.push(record.level);
      expect(record.context).toBe('TestContext');
      expect(new Date(record.time).toISOString()).toBe(record.time);
    }
    expect(levels).toEqual(['info', 'warn', 'error', 'debug', 'verbose', 'fatal']);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      message: 'finished\nnext line', correlationId: 'correlation-1',
    });
    expect(JSON.parse(String(output.mock.calls[2]?.[0]))).toMatchObject({
      message: 'failed', errorName: 'TypeError',
    });
  } finally {
    output.mockRestore();
  }
});

test('uses the JSON logger for contextual Nest loggers and protects envelope fields', () => {
  const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
  Logger.overrideLogger(new JsonLogger());
  try {
    new Logger('ServiceContext').log({
      message: 'finished', walletId: 'wallet-1', level: 'invalid', time: 'invalid', context: 'invalid',
    });
    const record = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(record).toMatchObject({
      level: 'info', context: 'ServiceContext', message: 'finished', walletId: 'wallet-1',
    });
    expect(new Date(record.time).toISOString()).toBe(record.time);
  } finally {
    output.mockRestore();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose', 'fatal']);
  }
});
