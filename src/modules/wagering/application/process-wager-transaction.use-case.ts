import { EntityManager, LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import { Money, MoneyProps } from '../../../shared/domain/money';
import { newId } from '../../../shared/new-id';
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

export class WalletNotFoundError extends Error { }
export class WalletMismatchError extends Error { }
export class IdempotencyConflictError extends Error { }

export interface ProcessWagerTransactionInput {
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
    constructor(@Inject(EntityManager) private readonly em: EntityManager) { }

    async execute(input: ProcessWagerTransactionInput): Promise<ProcessWagerTransactionResult> {
        if (input.kind === WagerTransactionKind.Opening) {
            throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
        }

        const money = Money.from(input.money);
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
            return await this.em.transactional(async (em) => {
                return this.processWithWalletLocked(em, input, money, payloadHash);
            });
        } catch (error) {
            if (error instanceof UniqueConstraintViolationException) {
                return this.resolveDuplicate(input.idempotencyKey, payloadHash);
            }
            throw error;
        }
    }

    private async processWithWalletLocked(
        em: EntityManager,
        input: ProcessWagerTransactionInput,
        money: Money,
        payloadHash: string,
    ): Promise<ProcessWagerTransactionResult> {
        const walletEntity = await em.findOne(
            WalletEntity,
            { id: input.walletId },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (!walletEntity) {
            throw new WalletNotFoundError('wallet not found');
        }

        const existing = await em.findOne(WagerTransactionEntity, { idempotencyKey: input.idempotencyKey });
        if (existing) {
            return replay(toWagerTransactionDomain(existing), payloadHash);
        }

        const wallet = toWalletDomain(walletEntity);
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

        if (transaction.kind === WagerTransactionKind.Bet) {
            applyBet(em, wallet, transaction);
        } else {
            throw new Error(`${transaction.kind} is not supported yet`);
        }

        em.persist(toNewWagerTransactionEntity(transaction));
        updateWalletEntity(walletEntity, wallet);

        return toResult(transaction, false);
    }

    private async resolveDuplicate(idempotencyKey: string, payloadHash: string): Promise<ProcessWagerTransactionResult> {
        const existing = await this.em.fork().findOne(WagerTransactionEntity, { idempotencyKey });
        if (existing) {
            return replay(toWagerTransactionDomain(existing), payloadHash);
        }
        throw new IdempotencyConflictError('externalTransactionId already used with a different Idempotency-Key');
    }
}

function applyBet(em: EntityManager, wallet: Wallet, transaction: WagerTransaction): void {
    try {
        const entry = wallet.debit({ entryId: newId(), transactionId: transaction.id, money: transaction.money });
        transaction.markProcessed({ observedBalance: wallet.balance });
        em.persist(toLedgerEntryEntity(entry));
    } catch (error) {
        if (error instanceof InsufficientBalanceError) {
            transaction.reject({ code: FailureCode.InsufficientFunds, observedBalance: wallet.balance });
            return;
        }
        throw error;
    }
}

function replay(existing: WagerTransaction, payloadHash: string): ProcessWagerTransactionResult {
    if (!existing.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError('same Idempotency-Key with a different payload');
    }
    return toResult(existing, true);
}

function toResult(transaction: WagerTransaction, idempotentReplay: boolean): ProcessWagerTransactionResult {
    const balance = transaction.observedBalance;
    if (!balance) {
        throw new Error('finished transaction must have an observed balance');
    }
    return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: balance.toJSON(),
        failureCode: transaction.failureCode,
        idempotentReplay,
    };
}
