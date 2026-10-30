import { ConnectionException, DeadlockException, LockWaitTimeoutException } from '@mikro-orm/core';

export function isTransientInfrastructureError(error: unknown): boolean {
  if (
    error instanceof ConnectionException ||
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException
  ) {
    return true;
  }
  if (error instanceof Error && 'code' in error) {
    const code = error.code;
    return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT';
  }
  return false;
}
