import { Money } from '../../../shared/domain/money';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WalletLedgerEntryEntity } from './wallet-ledger-entry.entity';

export function toLedgerEntryDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: entity.id,
    walletId: entity.walletId,
    transactionId: entity.transactionId,
    direction: entity.direction,
    money: Money.fromCents(entity.amountCents, entity.currency),
    balanceBefore: Money.fromCents(entity.balanceBeforeCents, entity.currency),
    balanceAfter: Money.fromCents(entity.balanceAfterCents, entity.currency),
    createdAt: entity.createdAt,
  });
}

export function toLedgerEntryEntity(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
  const entity = new WalletLedgerEntryEntity();
  entity.id = entry.id;
  entity.walletId = entry.walletId;
  entity.transactionId = entry.transactionId;
  entity.direction = entry.direction;
  entity.amountCents = entry.money.toCents();
  entity.currency = entry.money.currency;
  entity.balanceBeforeCents = entry.balanceBefore.toCents();
  entity.balanceAfterCents = entry.balanceAfter.toCents();
  entity.createdAt = entry.createdAt;
  return entity;
}

export function toLedgerEntryView(entity: WalletLedgerEntryEntity) {
  return {
    id: entity.id,
    transactionId: entity.transactionId,
    direction: entity.direction,
    money: Money.fromCents(entity.amountCents, entity.currency).toJSON(),
    balanceBefore: Money.fromCents(entity.balanceBeforeCents, entity.currency).toJSON(),
    balanceAfter: Money.fromCents(entity.balanceAfterCents, entity.currency).toJSON(),
    createdAt: entity.createdAt.toISOString(),
  };
}
