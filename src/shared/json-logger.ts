import type { LoggerService } from '@nestjs/common';

export class JsonLogger implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(level: string, value: unknown, optionalParams: unknown[]): void {
    let context = 'Application';
    const lastParam = optionalParams.at(-1);
    if (typeof lastParam === 'string') {
      context = lastParam;
    }

    let message = String(value);
    let fields: object = {};
    if (value instanceof Error) {
      message = value.message;
      fields = { errorName: value.name };
    } else if (typeof value === 'object' && value !== null) {
      fields = value;
      if ('message' in value && typeof value.message === 'string') {
        message = value.message;
      } else {
        message = 'structured log';
      }
    }

    const record = { ...fields, level, time: new Date().toISOString(), context, message };
    process.stdout.write(JSON.stringify(record) + '\n');
  }
}
