import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { LockMode } from '@mikro-orm/core';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import { isUuid } from '../../src/shared/is-uuid';
import { newId } from '../../src/shared/new-id';
import { JsonLogger } from '../../src/shared/json-logger';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/create-wallet.use-case';
import { WalletEntity } from '../../src/modules/wallet/infrastructure/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/wallet/infrastructure/wallet-ledger-entry.entity';
import { toLedgerEntryView } from '../../src/modules/wallet/infrastructure/wallet-ledger-entry.mapper';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction';
import { truncateAll } from './helpers';

let app: INestApplication;
let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let processTransaction: ProcessWagerTransactionUseCase;
let baseUrl: string;

interface LedgerPage {
  items: ReturnType<typeof toLedgerEntryView>[];
  nextCursor: string | null;
}

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  orm = app.get(MikroORM);
  await orm.migrator.up();
  createWallet = app.get(CreateWalletUseCase);
  processTransaction = app.get(ProcessWagerTransactionUseCase);
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateAll(orm);
});

async function openWalletWithBets(count: number) {
  const wallet = await createWallet.execute({
    playerId: newId(), initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  for (let index = 0; index < count; index++) {
    await processTransaction.execute(bet(wallet.id, wallet.playerId, `bet-${index}`));
  }
  return wallet;
}

function bet(walletId: string, playerId: string, externalTransactionId: string) {
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a', externalTransactionId, walletId, playerId,
    roundId: 'round-1', gameId: 'game-1', kind: WagerTransactionKind.Bet,
    money: { amount: '1.00', currency: 'BRL' },
  };
}

async function submit(body: object, idempotencyKey: string, correlationId?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey,
  };
  if (correlationId !== undefined) {
    headers['X-Correlation-Id'] = correlationId;
  }
  return fetch(`${baseUrl}/wagering/transactions`, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('wallet GET returns its current balance and version', async () => {
  const wallet = await openWalletWithBets(5);
  const response = await fetch(`${baseUrl}/wallets/${wallet.id}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: wallet.id, playerId: wallet.playerId, balance: { amount: '95.00', currency: 'BRL' }, version: 6,
  });
});

test('wallet endpoints validate UUIDs and return WALLET_NOT_FOUND', async () => {
  for (const walletId of ['invalid', newId()]) {
    for (const suffix of ['', '/ledger', '/reconciliation']) {
      let method = 'GET';
      if (suffix === '/reconciliation') {
        method = 'POST';
      }
      const response = await fetch(`${baseUrl}/wallets/${walletId}${suffix}`, { method });
      if (walletId === 'invalid') {
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'INVALID_PAYLOAD' });
      } else {
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: 'WALLET_NOT_FOUND' });
      }
    }
  }
});

test('ledger paginates six entries without duplicates even when timestamps are equal', async () => {
  setSystemTime(new Date('2026-10-29T12:00:00.000Z'));
  let wallet;
  try {
    wallet = await openWalletWithBets(5);
  } finally {
    setSystemTime();
  }
  const entries = await orm.em.fork().find(WalletLedgerEntryEntity, { walletId: wallet.id }, {
    orderBy: { createdAt: 'asc', id: 'asc' },
  });
  expect(new Set(entries.map((entry) => entry.createdAt.toISOString())).size).toBe(1);
  const collected: ReturnType<typeof toLedgerEntryView>[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url = new URL(`${baseUrl}/wallets/${wallet.id}/ledger`);
    url.searchParams.set('limit', '2');
    if (cursor !== null) {
      url.searchParams.set('cursor', cursor);
    }
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const page: LedgerPage = JSON.parse(await response.text());
    expect(page.items).toHaveLength(2);
    collected.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== null) {
      const lastItem = page.items.at(-1);
      expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({
        createdAt: lastItem?.createdAt, id: lastItem?.id,
      });
    }
    pages++;
    expect(pages).toBeLessThanOrEqual(3);
  } while (cursor !== null && pages < 4);

  expect(pages).toBe(3);
  expect(cursor).toBeNull();
  expect(collected).toHaveLength(6);
  expect(new Set(collected.map((item) => item.id)).size).toBe(6);
  expect(collected).toEqual(entries.map(toLedgerEntryView));
});

test('ledger rejects malformed cursors and invalid limits', async () => {
  const wallet = await openWalletWithBets(0);
  const invalidCursors = [
    '', 'invalid', '!!!', Buffer.from('null').toString('base64url'),
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: 'invalid', id: newId() })).toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: '2026-02-30T12:00:00.000Z', id: newId() })).toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), id: 'invalid' })).toString('base64url'),
  ];
  const invalidQueries = invalidCursors.map((cursor) => `cursor=${encodeURIComponent(cursor)}`);
  invalidQueries.push('limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=', 'limit=abc', 'limit=2&limit=3');
  for (const query of invalidQueries) {
    const response = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'INVALID_PAYLOAD' });
  }
});

test('ledger accepts limits 1 and 100 with a short final page', async () => {
  const wallet = await openWalletWithBets(0);
  for (const query of ['', '?limit=1', '?limit=100']) {
    const response = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger${query}`);
    expect(response.status).toBe(200);
    const page: LedgerPage = JSON.parse(await response.text());
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  }
});

test('ledger defaults to 50 entries and returns the remaining entry on the final page', async () => {
  const wallet = await openWalletWithBets(50);
  const response = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger`);
  expect(response.status).toBe(200);
  const first: LedgerPage = JSON.parse(await response.text());
  expect(first.items).toHaveLength(50);
  expect(typeof first.nextCursor).toBe('string');
  const last = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?cursor=${first.nextCursor}`);
  const page: LedgerPage = JSON.parse(await last.text());
  expect(page.items).toHaveLength(1);
  expect(page.nextCursor).toBeNull();
});

test('empty ledger reconciles to zero and has no next cursor', async () => {
  const wallet = await createWallet.execute({
    playerId: newId(), initialBalance: { amount: '0.00', currency: 'BRL' },
  });
  const ledger = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger`);
  expect(await ledger.json()).toEqual({ items: [], nextCursor: null });
  const reconciliation = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
  expect(reconciliation.status).toBe(200);
  expect(await reconciliation.json()).toMatchObject({
    consistent: true, difference: { amount: '0.00', currency: 'BRL' }, checkedEntries: 0,
  });
});

test('reconciliation detects signed differences without repairing the stored balance and logs a warning', async () => {
  const wallet = await openWalletWithBets(5);
  const consistent = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
  expect(consistent.status).toBe(200);
  expect(await consistent.json()).toEqual({
    walletId: wallet.id, storedBalance: { amount: '95.00', currency: 'BRL' },
    calculatedBalance: { amount: '95.00', currency: 'BRL' },
    difference: { amount: '0.00', currency: 'BRL' }, consistent: true, checkedEntries: 6,
  });

  const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    for (const example of [{ cents: 12345n, difference: '28.45' }, { cents: 9000n, difference: '-5.00' }]) {
      await orm.em.getConnection().execute('update wallets set balance_cents = ? where id = ?', [example.cents.toString(), wallet.id]);
      const response = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        consistent: false, difference: { amount: example.difference, currency: 'BRL' }, checkedEntries: 6,
      });
      const stored = await orm.em.fork().findOneOrFail(WalletEntity, wallet.id);
      expect(stored.balanceCents).toBe(example.cents);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
        level: 'warn', walletId: wallet.id, difference: { amount: example.difference, currency: 'BRL' },
      });
    }
  } finally {
    output.mockRestore();
  }
});

test('transaction GETs return the same complete view by ID and provider external ID', async () => {
  const wallet = await openWalletWithBets(0);
  const result = await processTransaction.execute(bet(wallet.id, wallet.playerId, 'external-1'));
  const byId = await fetch(`${baseUrl}/wagering/transactions/${result.transactionId}`);
  const byExternal = await fetch(`${baseUrl}/providers/provider-a/wagering/transactions/external-1`);
  expect(byId.status).toBe(200);
  expect(byExternal.status).toBe(200);
  const view = await byId.json();
  expect(await byExternal.json()).toEqual(view);
  expect(view).toEqual({
    id: result.transactionId, providerId: 'provider-a', externalTransactionId: 'external-1',
    walletId: wallet.id, playerId: wallet.playerId, roundId: 'round-1', gameId: 'game-1', kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' }, referenceExternalTransactionId: null, referenceTransactionId: null,
    status: 'PROCESSED', failureCode: null, observedBalance: { amount: '99.00', currency: 'BRL' },
    createdAt: expect.any(String), processedAt: expect.any(String),
  });
});

test('reconciliation waits for a wallet writer and reads the committed balance', async () => {
  const wallet = await openWalletWithBets(0);
  const em = orm.em.fork();
  await em.begin();
  let pending: Promise<Response> | undefined;
  try {
    const locked = await em.findOneOrFail(WalletEntity, wallet.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
    let finished = false;
    pending = fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' }).then((response) => {
      finished = true;
      return response;
    });
    await Bun.sleep(100);
    expect(finished).toBe(false);
    locked.balanceCents = 9000n;
    await em.commit();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      storedBalance: { amount: '90.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '-10.00', currency: 'BRL' }, consistent: false, checkedEntries: 1,
    });
  } finally {
    if (em.isInTransaction()) {
      await em.rollback();
    }
    if (pending) {
      await pending;
    }
  }
});

test('transaction GETs return TRANSACTION_NOT_FOUND and validate transaction UUIDs', async () => {
  for (const path of [`/wagering/transactions/${newId()}`, '/providers/missing/wagering/transactions/missing']) {
    const response = await fetch(baseUrl + path);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'TRANSACTION_NOT_FOUND' });
  }
  const invalid = await fetch(`${baseUrl}/wagering/transactions/invalid`);
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: 'INVALID_PAYLOAD' });
});

test('transaction GET represents absent pending fields as null', async () => {
  const wallet = await openWalletWithBets(0);
  const input = {
    ...bet(wallet.id, wallet.playerId, 'refund-1'), kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: 'missing-bet',
  };
  const result = await processTransaction.execute(input);
  const response = await fetch(`${baseUrl}/wagering/transactions/${result.transactionId}`);
  expect(await response.json()).toMatchObject({
    status: 'PENDING_REFERENCE', referenceExternalTransactionId: 'missing-bet', referenceTransactionId: null,
    failureCode: null, observedBalance: null, processedAt: null,
  });
});

test('submission propagates correlation IDs and emits safe completion replay and conflict JSON logs', async () => {
  const wallet = await openWalletWithBets(0);
  const input = bet(wallet.id, wallet.playerId, 'correlated-1');
  const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const first = await submit(input, input.idempotencyKey, 'correlation-1');
    expect(first.status).toBe(200);
    expect(first.headers.get('x-correlation-id')).toBe('correlation-1');
    const result: { transactionId: string } = JSON.parse(await first.text());
    const replay = await submit(input, input.idempotencyKey);
    expect(replay.status).toBe(200);
    expect(isUuid(replay.headers.get('x-correlation-id'))).toBe(true);
    expect(await replay.json()).toMatchObject({ transactionId: result.transactionId, idempotentReplay: true });
    const conflict = await submit({ ...input, money: { amount: '2.00', currency: 'BRL' } }, input.idempotencyKey, 'conflict-1');
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('x-correlation-id')).toBe('conflict-1');
    const records = output.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      level: 'info', message: 'wager transaction finished', correlationId: 'correlation-1',
      transactionId: result.transactionId, walletId: wallet.id, providerId: 'provider-a',
      status: 'PROCESSED', failureCode: null, idempotentReplay: false,
    });
    expect(records[1]).toMatchObject({ level: 'info', idempotentReplay: true, correlationId: replay.headers.get('x-correlation-id') });
    expect(records[2]).toMatchObject({ level: 'warn', correlationId: 'conflict-1', walletId: wallet.id, providerId: 'provider-a' });
    for (const record of records) {
      expect(record).not.toHaveProperty('playerId');
      expect(record).not.toHaveProperty('money');
      expect(record).not.toHaveProperty('amount');
      expect(record).not.toHaveProperty('payload');
      expect(JSON.stringify(record)).not.toContain(wallet.playerId);
    }
  } finally {
    output.mockRestore();
  }
});

test('503 submissions log only the error name and correlation ID', async () => {
  const failure = Object.assign(new TypeError('private payload must not be logged'), { code: 'ECONNRESET' });
  const execute = spyOn(processTransaction, 'execute').mockRejectedValue(failure);
  const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const input = bet(newId(), newId(), 'unavailable-1');
    const response = await submit(input, input.idempotencyKey, 'unavailable-correlation');
    expect(response.status).toBe(503);
    expect(response.headers.get('x-correlation-id')).toBe('unavailable-correlation');
    expect(await response.json()).toMatchObject({ error: 'TEMPORARILY_UNAVAILABLE' });
    expect(output).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(record).toMatchObject({ level: 'error', correlationId: 'unavailable-correlation', errorName: 'TypeError' });
    expect(Object.keys(record).sort()).toEqual(['context', 'correlationId', 'errorName', 'level', 'message', 'time']);
    expect(JSON.stringify(record)).not.toContain(failure.message);
  } finally {
    execute.mockRestore();
    output.mockRestore();
  }
});

test('health endpoints are public and readiness reflects PostgreSQL failures', async () => {
  const live = await fetch(`${baseUrl}/health/live`);
  expect(live.status).toBe(200);
  expect(await live.json()).toEqual({ status: 'ok' });
  const ready = await fetch(`${baseUrl}/health/ready`);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ status: 'ok', checks: { postgres: 'ok', sqs: 'ok' } });
  const execute = spyOn(orm.em.getConnection(), 'execute').mockRejectedValue(new Error('postgres unavailable'));
  try {
    const unavailable = await fetch(`${baseUrl}/health/ready`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: 'unavailable', checks: { postgres: 'down', sqs: 'ok' } });
  } finally {
    execute.mockRestore();
  }
});
