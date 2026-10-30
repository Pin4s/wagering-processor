const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for bun test; refusing to use the development database.');
}

process.env.DATABASE_URL = testDatabaseUrl;
process.env.SQS_WAGER_TRANSACTIONS_QUEUE = 'test-wager-transactions.fifo';
process.env.SQS_WAGER_TRANSACTIONS_DLQ = 'test-wager-transactions-dlq.fifo';
process.env.SQS_EVENTS_QUEUE = 'test-wagering-events.fifo';
