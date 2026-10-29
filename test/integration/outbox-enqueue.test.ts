import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config';
import { newId } from '../../src/shared/new-id';
import { OutboxMessageEntity } from '../../src/modules/messaging/infrastructure/outbox-message.entity';
import {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionUseCase,
} from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionEntity } from '../../src/modules/wagering/infrastructure/wager-transaction.entity';
import { CreateWalletUseCase, WalletAlreadyExistsError } from '../../src/modules/wallet/application/create-wallet.use-case';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/wallet/infrastructure/wallet-ledger-entry.entity';
import { truncateAll } from './helpers';

interface OutboxRow {
  id: string;
  event_type: string;
  published_at: Date | null;
  attempts: number;
  payload: {
    correlationId: string;
    causationId?: string;
    data: Record<string, unknown>;
  };
}

let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let process: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  createWallet = new CreateWalletUseCase(orm.em);
  process = new ProcessWagerTransactionUseCase(orm.em);
});

afterAll(async () => {
  await orm.close();
});

beforeEach(async () => {
  await truncateAll(orm);
});

async function openWallet(amount: string) {
  return createWallet.execute({ playerId: newId(), initialBalance: { amount, currency: 'BRL' } });
}

function request(
  wallet: { id: string; playerId: string },
  kind: WagerTransactionKind,
  amount: string,
  referenceExternalTransactionId?: string,
): ProcessWagerTransactionInput {
  const externalTransactionId = newId();
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    referenceExternalTransactionId,
  };
}

async function messagesFor(transactionId: string): Promise<OutboxRow[]> {
  return orm.em.getConnection().execute<OutboxRow[]>(
    "select * from outbox_messages where payload->'data'->>'transactionId' = ? order by event_type",
    [transactionId],
  );
}

async function allMessages(): Promise<OutboxRow[]> {
  return orm.em.getConnection().execute<OutboxRow[]>('select * from outbox_messages order by id');
}

function expectPending(messages: OutboxRow[], transactionId: string): void {
  for (const message of messages) {
    expect(message.published_at).toBeNull();
    expect(message.attempts).toBe(0);
    expect(message.payload.data.transactionId).toBe(transactionId);
  }
}

test('processed BET enqueues exactly two pending events with the supplied context', async () => {
  const wallet = await openWallet('100.00');
  const input = {
    ...request(wallet, WagerTransactionKind.Bet, '25.00'),
    correlationId: newId(),
    causationId: 'sqs-message-1',
  };
  const result = await process.execute(input);

  expect(result.status).toBe(WagerTransactionStatus.Processed);
  const messages = await messagesFor(result.transactionId);
  expect(messages.map((message) => message.event_type)).toEqual([
    'WagerTransactionProcessed',
    'WalletBalanceChanged',
  ]);
  expectPending(messages, result.transactionId);
  for (const message of messages) {
    expect(message.payload.correlationId).toBe(input.correlationId);
    expect(message.payload.causationId).toBe(input.causationId);
    expect(message.payload.data.walletId).toBe(wallet.id);
  }
  expect(messages[1]!.payload.data.balanceBefore).toEqual({ amount: '100.00', currency: 'BRL' });
  expect(messages[1]!.payload.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
  expect(messages[1]!.payload.data.walletVersion).toBe(2);
  expect(await allMessages()).toHaveLength(4);
});

test('LOSS enqueues only WagerTransactionProcessed', async () => {
  const wallet = await openWallet('0.00');
  const result = await process.execute(request(wallet, WagerTransactionKind.Loss, '25.00'));

  expect(result.status).toBe(WagerTransactionStatus.Processed);
  const messages = await allMessages();
  expect(messages.map((message) => message.event_type)).toEqual(['WagerTransactionProcessed']);
  expectPending(messages, result.transactionId);
});

test('BET with insufficient funds enqueues only WagerTransactionRejected with its failure code', async () => {
  const wallet = await openWallet('0.00');
  const result = await process.execute(request(wallet, WagerTransactionKind.Bet, '25.00'));

  expect(result.status).toBe(WagerTransactionStatus.Rejected);
  const messages = await allMessages();
  expect(messages.map((message) => message.event_type)).toEqual(['WagerTransactionRejected']);
  expect(messages[0]!.payload.data.failureCode).toBe(FailureCode.InsufficientFunds);
  expect(messages[0]!.payload.data.failureCode).toBe(result.failureCode);
  expectPending(messages, result.transactionId);
});

test('REFUND with a missing reference enqueues only WagerTransactionPendingReference', async () => {
  const wallet = await openWallet('0.00');
  const result = await process.execute(request(wallet, WagerTransactionKind.Refund, '25.00', 'missing-bet'));

  expect(result.status).toBe(WagerTransactionStatus.PendingReference);
  const messages = await allMessages();
  expect(messages.map((message) => message.event_type)).toEqual(['WagerTransactionPendingReference']);
  expect(messages[0]!.payload.data.referenceExternalTransactionId).toBe('missing-bet');
  expectPending(messages, result.transactionId);
});

test('replaying the same BET leaves the outbox unchanged', async () => {
  const wallet = await openWallet('100.00');
  const input = request(wallet, WagerTransactionKind.Bet, '25.00');
  const first = await process.execute(input);
  const before = await allMessages();

  const replay = await process.execute({ ...input, correlationId: newId(), causationId: 'replayed-message' });

  expect(replay.idempotentReplay).toBe(true);
  expect(replay.transactionId).toBe(first.transactionId);
  expect(before).toHaveLength(4);
  expect(await allMessages()).toEqual(before);
});

test('wallet opening enqueues two events and duplicate creation rolls back without new events', async () => {
  const input = {
    playerId: newId(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
    correlationId: newId(),
  };
  const wallet = await createWallet.execute(input);
  const opening = await orm.em.fork().findOneOrFail(WagerTransactionEntity, {
    walletId: wallet.id,
    kind: WagerTransactionKind.Opening,
  });
  const messages = await messagesFor(opening.id);
  expect(messages.map((message) => message.event_type)).toEqual([
    'WagerTransactionProcessed',
    'WalletBalanceChanged',
  ]);
  expect(messages[0]!.payload.data.kind).toBe(WagerTransactionKind.Opening);
  expectPending(messages, opening.id);
  for (const message of messages) {
    expect(message.payload.correlationId).toBe(input.correlationId);
  }
  const before = await allMessages();
  expect(before).toHaveLength(2);

  await expect(createWallet.execute(input)).rejects.toThrow(WalletAlreadyExistsError);

  expect(await allMessages()).toEqual(before);
  const em = orm.em.fork();
  expect(await em.count(WalletEntity, {})).toBe(1);
  expect(await em.count(WagerTransactionEntity, {})).toBe(1);
  expect(await em.count(WalletLedgerEntryEntity, {})).toBe(1);
});

test('the same BET sent 50 times in parallel enqueues only two events plus the opening events', async () => {
  const wallet = await openWallet('100.00');
  const input = request(wallet, WagerTransactionKind.Bet, '25.00');
  const results = await Promise.all(Array.from({ length: 50 }, () => process.execute(input)));

  expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
  const transactionId = results[0]!.transactionId;
  for (const result of results) {
    expect(result.transactionId).toBe(transactionId);
  }
  const messages = await messagesFor(transactionId);
  expect(messages.map((message) => message.event_type)).toEqual([
    'WagerTransactionProcessed',
    'WalletBalanceChanged',
  ]);
  expectPending(messages, transactionId);
  expect(await allMessages()).toHaveLength(4);
});

test.each([undefined, ''])('BET generates one shared correlationId when the input is %p', async (correlationId) => {
  const wallet = await openWallet('100.00');
  const result = await process.execute({ ...request(wallet, WagerTransactionKind.Bet, '25.00'), correlationId });
  const messages = await messagesFor(result.transactionId);

  expect(messages).toHaveLength(2);
  expect(messages[0]!.payload.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(messages[1]!.payload.correlationId).toBe(messages[0]!.payload.correlationId);
  for (const message of messages) {
    expect(message.payload.causationId).toBeUndefined();
  }
});

test.each([undefined, ''])('wallet opening generates one shared correlationId when the input is %p', async (correlationId) => {
  await createWallet.execute({
    playerId: newId(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
    correlationId,
  });
  const messages = await allMessages();

  expect(messages).toHaveLength(2);
  expect(messages[0]!.payload.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(messages[1]!.payload.correlationId).toBe(messages[0]!.payload.correlationId);
});

test('zero balance wallet opening does not enqueue events', async () => {
  await openWallet('0.00');
  expect(await allMessages()).toHaveLength(0);
});

test('rolling back after SQL flush removes the wallet, wager, ledger and outbox events together', async () => {
  const failure = new Error('forced rollback after flush');
  await expect(orm.em.fork().transactional(async (em) => {
    const wallet = await new CreateWalletUseCase(em).execute({
      playerId: newId(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    await new ProcessWagerTransactionUseCase(em).execute(request(wallet, WagerTransactionKind.Bet, '25.00'));
    await em.flush();
    expect(await em.count(OutboxMessageEntity, {})).toBe(4);
    throw failure;
  })).rejects.toThrow(failure);

  const em = orm.em.fork();
  expect(await allMessages()).toHaveLength(0);
  expect(await em.count(WalletEntity, {})).toBe(0);
  expect(await em.count(WagerTransactionEntity, {})).toBe(0);
  expect(await em.count(WalletLedgerEntryEntity, {})).toBe(0);
});
