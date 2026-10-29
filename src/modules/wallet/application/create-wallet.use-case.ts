import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import { Money, MoneyProps } from '../../../shared/domain/money';
import { newId } from '../../../shared/new-id';
import { computePayloadHash } from '../../wagering/domain/payload-hash';
import { WagerTransaction, WagerTransactionKind } from '../../wagering/domain/wager-transaction';
import { toNewWagerTransactionEntity } from '../../wagering/infrastructure/wager-transaction.mapper';
import { Wallet } from '../domain/wallet';
import { toLedgerEntryEntity } from '../infrastructure/wallet-ledger-entry.mapper';
import { toNewWalletEntity } from '../infrastructure/wallet.mapper';

export class WalletAlreadyExistsError extends Error {}

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const initialBalance = Money.from(input.initialBalance);  
    const openingTransactionId = newId();

    const { wallet, openingEntry } = Wallet.open({
      id: newId(),
      playerId: input.playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: newId(),
    });

    try {
      await this.em.transactional(async (em) => {
        em.persist(toNewWalletEntity(wallet));

        if (openingEntry) {
          const opening = createOpeningTransaction(wallet, openingTransactionId, initialBalance);
          em.persist(toNewWagerTransactionEntity(opening));
          em.persist(toLedgerEntryEntity(openingEntry));
        }
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError('wallet already exists for this player and currency');
      }
      throw error;
    }

    return wallet;
  }
}

function createOpeningTransaction(wallet: Wallet, transactionId: string, money: Money): WagerTransaction {
  const providerId = 'internal';
  const externalTransactionId = `opening:${wallet.id}`;
  const roundId = 'opening';
  const gameId = 'opening';

  const transaction = WagerTransaction.create({
    id: transactionId,
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    payloadHash: computePayloadHash({
      providerId,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId,
      gameId,
      kind: WagerTransactionKind.Opening,
      money,
    }),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId,
    gameId,
    kind: WagerTransactionKind.Opening,
    money,
  });

  transaction.markProcessed({ observedBalance: wallet.balance });
  return transaction;
}