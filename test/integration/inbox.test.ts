import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config';
import { newId } from '../../src/shared/new-id';
import { InboxMessageEntity } from '../../src/modules/messaging/infrastructure/inbox-message.entity';
import { toInboxMessageDomain } from '../../src/modules/messaging/infrastructure/inbox-message.mapper';
import { OutboxMessageEntity } from '../../src/modules/messaging/infrastructure/outbox-message.entity';
import {
  IdempotencyConflictError,
  ProcessWagerTransactionInput,
  ProcessWagerTransactionUseCase,
  WAGER_TRANSACTIONS_CONSUMER_NAME,
  WalletNotFoundError,
} from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionEntity } from '../../src/modules/wagering/infrastructure/wager-transaction.entity';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/create-wallet.use-case';
import { LedgerDirection } from '../../src/modules/wallet/domain/wallet-ledger-entry';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/wallet/infrastructure/wallet-ledger-entry.entity';
import { truncateAll } from './helpers';

let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let processTransaction: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  createWallet = new CreateWalletUseCase(orm.em);
  processTransaction = new ProcessWagerTransactionUseCase(orm.em);
});

afterAll(async () => {
  await orm.close();
});

beforeEach(async () => {
  await truncateAll(orm);
});

async function openWallet() {
  return createWallet.execute({
    playerId: newId(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
}

function bet(wallet: { id: string; playerId: string }): ProcessWagerTransactionInput & {
  inbox: { consumerName: string; messageId: string };
} {
  const externalTransactionId = newId();
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: newId(),
    inbox: { consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME, messageId: newId() },
  };
}

async function outboxIds(): Promise<string[]> {
  const rows = await orm.em.fork().find(OutboxMessageEntity, {}, { orderBy: { id: 'asc' } });
  return rows.map((row) => row.id);
}

async function expectSingleDebit(walletId: string): Promise<void> {
  const em = orm.em.fork();
  expect(await em.count(WalletLedgerEntryEntity, { walletId, direction: LedgerDirection.Debit })).toBe(1);
  const wallet = await em.findOneOrFail(WalletEntity, walletId);
  expect(wallet.balanceCents).toBe(7500n);
}

test('a new message commits its processed inbox row, wager, ledger entry and outbox together', async () => {
  const wallet = await openWallet();
  const input = bet(wallet);

  const result = await processTransaction.execute(input);

  expect(result.status).toBe(WagerTransactionStatus.Processed);
  expect(result.idempotentReplay).toBe(false);
  const em = orm.em.fork();
  const messages = await em.find(InboxMessageEntity, {});
  expect(messages).toHaveLength(1);
  const message = messages[0]!;
  expect(message.consumerName).toBe(WAGER_TRANSACTIONS_CONSUMER_NAME);
  expect(message.messageId).toBe(input.inbox.messageId);
  expect(message.receivedAt).toBeInstanceOf(Date);
  expect(message.processedAt).toBeInstanceOf(Date);
  expect(message.processedAt?.getTime()).toBeGreaterThanOrEqual(message.receivedAt.getTime());
  expect(toInboxMessageDomain(message).isProcessed()).toBe(true);
  const transaction = await em.findOneOrFail(WagerTransactionEntity, result.transactionId);
  expect(message.payloadHash).toBe(transaction.payloadHash);
  expect(message.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  expect(await em.count(WagerTransactionEntity, { kind: WagerTransactionKind.Bet })).toBe(1);
  expect(await em.count(WalletLedgerEntryEntity, { transactionId: result.transactionId })).toBe(1);
  expect(await outboxIds()).toHaveLength(4);
  await expectSingleDebit(wallet.id);
});

test('the same message ID is ignored without another debit or new outbox events', async () => {
  const wallet = await openWallet();
  const input = bet(wallet);
  const first = await processTransaction.execute(input);
  const beforeMessages = await orm.em.fork().find(InboxMessageEntity, {});
  const beforeEvents = await outboxIds();

  const replay = await processTransaction.execute(input);

  expect(replay.idempotentReplay).toBe(true);
  expect(replay.transactionId).toBe(first.transactionId);
  expect(await orm.em.fork().find(InboxMessageEntity, {})).toEqual(beforeMessages);
  expect(beforeMessages).toHaveLength(1);
  expect(await outboxIds()).toEqual(beforeEvents);
  await expectSingleDebit(wallet.id);
});

test('a different message ID records another inbox row while replaying the same business operation', async () => {
  const wallet = await openWallet();
  const input = bet(wallet);
  const first = await processTransaction.execute(input);
  const beforeEvents = await outboxIds();
  const secondMessageId = newId();

  const replay = await processTransaction.execute({
    ...input,
    inbox: { consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME, messageId: secondMessageId },
    causationId: secondMessageId,
  });

  expect(replay.idempotentReplay).toBe(true);
  expect(replay.transactionId).toBe(first.transactionId);
  const messages = await orm.em.fork().find(InboxMessageEntity, {});
  expect(messages).toHaveLength(2);
  expect(messages.map((message) => message.messageId).sort()).toEqual([input.inbox.messageId, secondMessageId].sort());
  expect(new Set(messages.map((message) => message.payloadHash)).size).toBe(1);
  for (const message of messages) {
    expect(message.processedAt).toBeInstanceOf(Date);
  }
  expect(await outboxIds()).toEqual(beforeEvents);
  await expectSingleDebit(wallet.id);
});

test('a missing wallet does not leave an inbox row or any operation records', async () => {
  const input = bet({ id: newId(), playerId: newId() });

  await expect(processTransaction.execute(input)).rejects.toThrow(WalletNotFoundError);

  const em = orm.em.fork();
  expect(await em.count(InboxMessageEntity, {})).toBe(0);
  expect(await em.count(WagerTransactionEntity, {})).toBe(0);
  expect(await em.count(WalletLedgerEntryEntity, {})).toBe(0);
  expect(await outboxIds()).toHaveLength(0);
});

test('the HTTP path without inbox metadata keeps the existing behavior and writes no inbox row', async () => {
  const wallet = await openWallet();
  const { inbox, ...input } = bet(wallet);

  const result = await processTransaction.execute(input);

  expect(result.status).toBe(WagerTransactionStatus.Processed);
  expect(result.idempotentReplay).toBe(false);
  expect(await orm.em.fork().count(InboxMessageEntity, {})).toBe(0);
  expect(await outboxIds()).toHaveLength(4);
  await expectSingleDebit(wallet.id);
});

test('the same message delivered 50 times in parallel creates one inbox row and one debit', async () => {
  const wallet = await openWallet();
  const input = bet(wallet);

  const results = await Promise.all(Array.from({ length: 50 }, () => processTransaction.execute(input)));

  expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
  expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
  expect(await orm.em.fork().count(InboxMessageEntity, {})).toBe(1);
  expect(await outboxIds()).toHaveLength(4);
  await expectSingleDebit(wallet.id);
});

test('the composite inbox key allows the same message ID for different consumers', async () => {
  const wallet = await openWallet();
  const input = bet(wallet);
  const first = await processTransaction.execute(input);
  const beforeEvents = await outboxIds();

  const replay = await processTransaction.execute({
    ...input,
    inbox: { consumerName: 'another-consumer', messageId: input.inbox.messageId },
  });

  expect(replay.transactionId).toBe(first.transactionId);
  expect(replay.idempotentReplay).toBe(true);
  const messages = await orm.em.fork().find(InboxMessageEntity, {});
  expect(messages).toHaveLength(2);
  expect(messages.map((message) => message.consumerName).sort()).toEqual([
    'another-consumer', WAGER_TRANSACTIONS_CONSUMER_NAME,
  ].sort());
  expect(new Set(messages.map((message) => message.messageId)).size).toBe(1);
  expect(await outboxIds()).toEqual(beforeEvents);
  await expectSingleDebit(wallet.id);
});

test('an idempotency conflict rolls back the newly registered inbox message', async () => {
  const wallet = await openWallet();
  const input = bet(wallet);
  await processTransaction.execute(input);
  const beforeEvents = await outboxIds();

  await expect(processTransaction.execute({
    ...input,
    inbox: { consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME, messageId: newId() },
    money: { amount: '30.00', currency: 'BRL' },
  })).rejects.toThrow(IdempotencyConflictError);

  expect(await orm.em.fork().count(InboxMessageEntity, {})).toBe(1);
  expect(await outboxIds()).toEqual(beforeEvents);
  await expectSingleDebit(wallet.id);
});

test('rollback after SQL flush removes inbox, wager, ledger and outbox changes together', async () => {
  const wallet = await openWallet();
  const input = bet(wallet);
  const beforeEvents = await outboxIds();
  const failure = new Error('forced rollback after inbox flush');

  await expect(orm.em.fork().transactional(async (em) => {
    const result = await new ProcessWagerTransactionUseCase(em).execute(input);
    await em.flush();
    expect(await em.count(InboxMessageEntity, {})).toBe(1);
    expect(await em.count(WagerTransactionEntity, { id: result.transactionId })).toBe(1);
    expect(await em.count(WalletLedgerEntryEntity, { transactionId: result.transactionId })).toBe(1);
    expect(await em.count(OutboxMessageEntity, {})).toBe(4);
    throw failure;
  })).rejects.toThrow(failure);

  const em = orm.em.fork();
  expect(await em.count(InboxMessageEntity, {})).toBe(0);
  expect(await em.count(WagerTransactionEntity, { kind: WagerTransactionKind.Bet })).toBe(0);
  expect(await em.count(WalletLedgerEntryEntity, { direction: LedgerDirection.Debit })).toBe(0);
  expect(await outboxIds()).toEqual(beforeEvents);
  expect((await em.findOneOrFail(WalletEntity, wallet.id)).balanceCents).toBe(10000n);
});
