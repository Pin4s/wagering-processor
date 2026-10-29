import { EntityManager, LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Money, MoneyProps } from '../../../shared/domain/money';
import { newId } from '../../../shared/new-id';
import { EventContext, IntegrationEvent } from '../../messaging/domain/integration-event';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import {
    WagerTransactionPendingReference,
    WagerTransactionProcessed,
    WagerTransactionRejected,
    WalletBalanceChanged,
} from '../../messaging/domain/wagering-events';
import { toNewOutboxMessageEntity } from '../../messaging/infrastructure/outbox-message.mapper';
import { FailureCode } from '../../wagering/domain/failure-code';
import { computePayloadHash } from '../../wagering/domain/payload-hash';
import {
    InvalidWagerTransactionError,
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
} from '../../wagering/domain/wager-transaction';
import { WagerTransactionEntity } from '../../wagering/infrastructure/wager-transaction.entity';
import { toNewWagerTransactionEntity, toWagerTransactionDomain } from '../../wagering/infrastructure/wager-transaction.mapper';
import { InsufficientBalanceError, Wallet } from '../../wallet/domain/wallet';
import { toLedgerEntryEntity } from '../../wallet/infrastructure/wallet-ledger-entry.mapper';
import { WalletEntity } from '../../wallet/infrastructure/wallet.entity';
import { toWalletDomain, updateWalletEntity } from '../../wallet/infrastructure/wallet.mapper';
import { LedgerDirection, WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';

export class WalletNotFoundError extends Error { }
export class WalletMismatchError extends Error { }
export class IdempotencyConflictError extends Error { }

export interface ProcessWagerTransactionInput {
    correlationId?: string;
    causationId?: string;
    idempotencyKey: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
}

export interface ProcessWagerTransactionResult {
    transactionId: string;
    status: WagerTransactionStatus;
    balance: MoneyProps;
    failureCode?: FailureCode;
    idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
    private readonly logger = new Logger(ProcessWagerTransactionUseCase.name);

    constructor(@Inject(EntityManager) private readonly em: EntityManager) { }

    async execute(input: ProcessWagerTransactionInput): Promise<ProcessWagerTransactionResult> {
        if (input.kind === WagerTransactionKind.Opening) {
            throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
        }

        const money = Money.from(input.money);
        let correlationId = input.correlationId;
        if (!correlationId) {
            correlationId = newId();
        }
        const context: EventContext = { correlationId, causationId: input.causationId };
        const payloadHash = computePayloadHash({
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
            playerId: input.playerId,
            walletId: input.walletId,
            roundId: input.roundId,
            gameId: input.gameId,
            kind: input.kind,
            money,
            referenceExternalTransactionId: input.referenceExternalTransactionId,
        });

        try {
            let result: ProcessWagerTransactionResult;
            try {
                result = await this.em.transactional(async (em) => {
                    return this.processWithWalletLocked(em, input, money, payloadHash, context);
                });
            } catch (error) {
                if (error instanceof UniqueConstraintViolationException) {
                    result = await this.resolveDuplicate(input.idempotencyKey, payloadHash);
                } else {
                    throw error;
                }
            }
            this.logger.log({
                message: 'wager transaction finished',
                correlationId: context.correlationId,
                transactionId: result.transactionId,
                walletId: input.walletId,
                providerId: input.providerId,
                status: result.status,
                failureCode: result.failureCode ?? null,
                idempotentReplay: result.idempotentReplay,
            });
            return result;
        } catch (error) {
            if (error instanceof IdempotencyConflictError) {
                this.logger.warn({
                    message: 'wager transaction idempotency conflict',
                    correlationId: context.correlationId,
                    walletId: input.walletId,
                    providerId: input.providerId,
                });
            }
            throw error;
        }
    }

    private async processWithWalletLocked(
        em: EntityManager,
        input: ProcessWagerTransactionInput,
        money: Money,
        payloadHash: string,
        context: EventContext,
    ): Promise<ProcessWagerTransactionResult> {
        const walletEntity = await em.findOne(
            WalletEntity,
            { id: input.walletId },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (!walletEntity) {
            throw new WalletNotFoundError('wallet not found');
        }
        const wallet = toWalletDomain(walletEntity);
        const existing = await em.findOne(WagerTransactionEntity, { idempotencyKey: input.idempotencyKey });

        if (existing) {
            return replay(toWagerTransactionDomain(existing), payloadHash, wallet.balance);
        }

        if (input.playerId !== wallet.playerId || money.currency !== wallet.currency) {
            throw new WalletMismatchError('player or currency does not match the wallet');
        }
        const transaction = WagerTransaction.create({
            id: newId(),
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
            idempotencyKey: input.idempotencyKey,
            payloadHash,
            walletId: input.walletId,
            playerId: input.playerId,
            roundId: input.roundId,
            gameId: input.gameId,
            kind: input.kind,
            money,
            referenceExternalTransactionId: input.referenceExternalTransactionId,
        });

        let entry: WalletLedgerEntry | undefined;
        if (transaction.kind === WagerTransactionKind.Bet) {
            entry = applyBet(em, wallet, transaction);
        } else if (transaction.kind === WagerTransactionKind.Win) {
            entry = applyWin(em, wallet, transaction);
        } else if (transaction.kind === WagerTransactionKind.Loss) {
            entry = applyLoss(wallet, transaction);
        } else if (
            transaction.kind === WagerTransactionKind.Refund ||
            transaction.kind === WagerTransactionKind.Rollback
        ) {
            entry = await applyReversal(em, wallet, transaction);
        } else {
            throw new Error(`${transaction.kind} is not supported yet`);
        }

        em.persist(toNewWagerTransactionEntity(transaction));
        updateWalletEntity(walletEntity, wallet);

        for (const event of eventsFor(transaction, wallet, entry, context)) {
            em.persist(toNewOutboxMessageEntity(OutboxMessage.enqueue(event)));
        }

        return toResult(transaction, false, wallet.balance);
    }

    private async resolveDuplicate(idempotencyKey: string, payloadHash: string): Promise<ProcessWagerTransactionResult> {
        const em = this.em.fork();
        const existing = await em.findOne(WagerTransactionEntity, { idempotencyKey });
        if (existing) {
            const walletEntity = await em.findOneOrFail(WalletEntity, { id: existing.walletId });
            const currentBalance = Money.fromCents(walletEntity.balanceCents, walletEntity.currency);
            return replay(toWagerTransactionDomain(existing), payloadHash, currentBalance);
        }
        throw new IdempotencyConflictError('externalTransactionId already used with a different Idempotency-Key');
    }
}

function applyBet(em: EntityManager, wallet: Wallet, transaction: WagerTransaction): WalletLedgerEntry | undefined {
    try {
        const entry = wallet.debit({ entryId: newId(), transactionId: transaction.id, money: transaction.money });
        transaction.markProcessed({ observedBalance: wallet.balance });
        em.persist(toLedgerEntryEntity(entry));
        return entry;
    } catch (error) {
        if (error instanceof InsufficientBalanceError) {
            transaction.reject({ code: FailureCode.InsufficientFunds, observedBalance: wallet.balance });
            return;
        }
        throw error;
    }
}

function applyWin(em: EntityManager, wallet: Wallet, transaction: WagerTransaction): WalletLedgerEntry {
    const entry = wallet.credit({ entryId: newId(), transactionId: transaction.id, money: transaction.money });
    transaction.markProcessed({ observedBalance: wallet.balance });
    em.persist(toLedgerEntryEntity(entry));
    return entry;
}

function applyLoss(wallet: Wallet, transaction: WagerTransaction): undefined {
    transaction.markProcessed({ observedBalance: wallet.balance });
    return undefined;
}

async function applyReversal(
    em: EntityManager,
    wallet: Wallet,
    transaction: WagerTransaction,
): Promise<WalletLedgerEntry | undefined> {
    const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    if (!referenceExternalTransactionId) {
        throw new InvalidWagerTransactionError(`${transaction.kind} requires referenceExternalTransactionId`);
    }

    const referenceEntity = await em.findOne(WagerTransactionEntity, {
        providerId: transaction.providerId,
        externalTransactionId: referenceExternalTransactionId,
    });
    if (!referenceEntity) {
        transaction.markPendingReference();
        return;
    }
    const reference = toWagerTransactionDomain(referenceEntity);

    if (reference.status === WagerTransactionStatus.PendingReference) {
        transaction.markPendingReference();
        return;
    }

    const problem = await findReversalProblem(em, transaction, reference);
    if (problem) {
        transaction.reject({ code: problem, observedBalance: wallet.balance });
        return;
    }

    const direction = transaction.ledgerDirectionFor(reference);
    let entry: WalletLedgerEntry;
    if (direction === LedgerDirection.Credit) {
        entry = wallet.credit({ entryId: newId(), transactionId: transaction.id, money: transaction.money });
        em.persist(toLedgerEntryEntity(entry));
    } else {
        try {
            entry = wallet.debit({ entryId: newId(), transactionId: transaction.id, money: transaction.money });
            em.persist(toLedgerEntryEntity(entry));
        } catch (error) {
            if (error instanceof InsufficientBalanceError) {
                transaction.reject({ code: FailureCode.ReversalInsufficientFunds, observedBalance: wallet.balance });
                return;
            }
            throw error;
        }
    }

    transaction.markProcessed({ observedBalance: wallet.balance, referenceTransactionId: reference.id });
    return entry;
}

function eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    context: EventContext,
): IntegrationEvent<unknown>[] {
    const events: IntegrationEvent<unknown>[] = [];
    if (transaction.status === WagerTransactionStatus.Processed) {
        events.push(WagerTransactionProcessed.from(transaction, wallet.balance, context));
        if (entry) {
            events.push(WalletBalanceChanged.from(wallet, entry, context));
        }
    } else if (transaction.status === WagerTransactionStatus.Rejected) {
        const failureCode = transaction.failureCode;
        if (!failureCode) {
            throw new Error('rejected transaction requires failureCode');
        }
        events.push(WagerTransactionRejected.from(transaction, failureCode, wallet.balance, context));
    } else if (transaction.status === WagerTransactionStatus.PendingReference) {
        const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
        if (!referenceExternalTransactionId) {
            throw new Error('pending reference transaction requires referenceExternalTransactionId');
        }
        events.push(WagerTransactionPendingReference.from(transaction, referenceExternalTransactionId, context));
    }
    return events;
}

async function findReversalProblem(
    em: EntityManager,
    transaction: WagerTransaction,
    reference: WagerTransaction,
): Promise<FailureCode | undefined> {
    if (!isAllowedReferenceKind(transaction.kind, reference.kind)) {
        return FailureCode.InvalidReferenceKind;
    }
    if (
        reference.playerId !== transaction.playerId ||
        reference.walletId !== transaction.walletId ||
        reference.money.currency !== transaction.money.currency ||
        reference.roundId !== transaction.roundId
    ) {
        return FailureCode.ReferenceMismatch;
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
        return FailureCode.ReferenceNotProcessed;
    }
    if (!reference.money.equals(transaction.money)) {
        return FailureCode.AmountMismatch;
    }

    const appliedReversals = await em.count(WagerTransactionEntity, {
        referenceTransactionId: reference.id,
        kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    if (appliedReversals > 0) {
        return FailureCode.AlreadyReversed;
    }

    return undefined;
}

function isAllowedReferenceKind(kind: WagerTransactionKind, referenceKind: WagerTransactionKind): boolean {
    if (kind === WagerTransactionKind.Refund) {
        return referenceKind === WagerTransactionKind.Bet;
    }
    if (kind === WagerTransactionKind.Rollback) {
        return (
            referenceKind === WagerTransactionKind.Bet ||
            referenceKind === WagerTransactionKind.Win ||
            referenceKind === WagerTransactionKind.Refund
        );
    }
    return false;
}

function replay(
    existing: WagerTransaction,
    payloadHash: string,
    currentBalance: Money,
): ProcessWagerTransactionResult {
    if (!existing.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError('same Idempotency-Key with a different payload');
    }
    return toResult(existing, true, currentBalance);
}
function toResult(
    transaction: WagerTransaction,
    idempotentReplay: boolean,
    currentBalance: Money,
): ProcessWagerTransactionResult {
    let balance = transaction.observedBalance;
    if (!balance) {
        balance = currentBalance;
    }
    return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: balance.toJSON(),
        failureCode: transaction.failureCode,
        idempotentReplay,
    };
}
