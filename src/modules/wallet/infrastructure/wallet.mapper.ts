import { Money } from '../../../shared/domain/money';
import { Wallet } from '../domain/wallet';
import { WalletEntity } from './wallet.entity';

export function toWalletDomain(entity: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: entity.id,
    playerId: entity.playerId,
    currency: entity.currency,
    balance: Money.fromCents(entity.balanceCents, entity.currency),
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  });
}

export function toNewWalletEntity(wallet: Wallet): WalletEntity {
  const entity = new WalletEntity();
  entity.id = wallet.id;
  entity.playerId = wallet.playerId;
  entity.currency = wallet.currency;
  entity.balanceCents = wallet.balance.toCents();
  entity.version = wallet.version;
  entity.createdAt = wallet.createdAt;
  entity.updatedAt = wallet.updatedAt;
  return entity;
}

export function updateWalletEntity(entity: WalletEntity, wallet: Wallet): void {
  entity.balanceCents = wallet.balance.toCents();
  entity.version = wallet.version;
  entity.updatedAt = wallet.updatedAt;
}

export function toWalletView(entity: WalletEntity) {
  return {
    id: entity.id,
    playerId: entity.playerId,
    balance: Money.fromCents(entity.balanceCents, entity.currency).toJSON(),
    version: entity.version,
  };
}
