import { Logger } from '@nestjs/common';

export type BackgroundLoopName = 'consumer' | 'publisher' | 'pending-reference-worker';

export function backgroundLoopBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return 0;
  }
  return Math.min(30_000, 1_000 * 2 ** Math.min(consecutiveFailures - 1, 5));
}

export class BackgroundLoopDiagnostics {
  private consecutiveFailures = 0;
  private lastErrorType?: string;

  constructor(private readonly logger: Logger, private readonly loop: BackgroundLoopName) {}

  failed(error: unknown): number {
    this.consecutiveFailures++;
    let errorName = 'UnknownError';
    if (error instanceof Error) {
      errorName = error.constructor.name;
    }
    const errorCode = findErrorCode(error) ?? null;
    const errorType = `${errorName}:${errorCode ?? ''}`;
    const nextRetryInMs = backgroundLoopBackoffMs(this.consecutiveFailures);
    if (isPowerOfTwo(this.consecutiveFailures) || errorType !== this.lastErrorType) {
      this.logger.error({
        message: 'background loop failed, dependency unavailable?',
        loop: this.loop,
        errorName,
        errorCode,
        consecutiveFailures: this.consecutiveFailures,
        nextRetryInMs,
      });
    }
    this.lastErrorType = errorType;
    return nextRetryInMs;
  }

  succeeded(): void {
    if (this.consecutiveFailures > 0) {
      this.logger.log({
        message: 'background loop recovered',
        loop: this.loop,
        afterFailures: this.consecutiveFailures,
      });
      this.consecutiveFailures = 0;
      this.lastErrorType = undefined;
    }
  }
}

function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && Math.log2(value) % 1 === 0;
}

function findErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  if ('code' in error && typeof error.code === 'string' && error.code.length > 0) {
    return error.code;
  }
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const code = findErrorCode(nested);
      if (code) {
        return code;
      }
    }
  }
  if ('cause' in error) {
    return findErrorCode(error.cause);
  }
  return undefined;
}
