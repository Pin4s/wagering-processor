import { Check, Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { WalletEntity } from '../../wallet/infrastructure/wallet.entity';
import { FailureCode } from '../domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';

@Entity({ tableName: 'wager_transactions' })
@Unique({ name: 'wager_transactions_idempotency_key_uq', properties: ['idempotencyKey'] })
@Unique({ name: 'wager_transactions_provider_external_uq', properties: ['providerId', 'externalTransactionId'] })
@Index({
    name: 'wager_transactions_one_reversal_per_reference_uq',
    expression: `create unique index "wager_transactions_one_reversal_per_reference_uq" on "wager_transactions" ("reference_transaction_id") where kind in ('REFUND', 'ROLLBACK')`,
})
@Check({ name: 'wager_transactions_amount_non_negative', expression: 'amount_cents >= 0' })
export class WagerTransactionEntity {
    @PrimaryKey({ type: 'uuid' })
    id!: string;

    @Property()
    providerId!: string;

    @Property()
    externalTransactionId!: string;

    @Property()
    idempotencyKey!: string;

    @Property({ columnType: 'char(64)' })
    payloadHash!: string;

    @ManyToOne(() => WalletEntity, { mapToPk: true, fieldName: 'wallet_id' })
    walletId!: string;

    @Property({ type: 'uuid' })
    playerId!: string;

    @Property()
    roundId!: string;

    @Property()
    gameId!: string;

    @Enum({ items: () => WagerTransactionKind })
    kind!: WagerTransactionKind;

    @Property({ type: 'bigint' })
    amountCents!: bigint;

    @Property({ columnType: 'char(3)' })
    currency!: string;

    @Property({ nullable: true })
    referenceExternalTransactionId?: string;

    @ManyToOne(() => WagerTransactionEntity, {
        mapToPk: true,
        fieldName: 'reference_transaction_id',
        nullable: true,
    })
    referenceTransactionId?: string;

    @Enum({ items: () => WagerTransactionStatus })
    status!: WagerTransactionStatus;

    @Enum({ items: () => FailureCode, nullable: true })
    failureCode?: FailureCode;

    @Property({ type: 'bigint', nullable: true })
    observedBalanceCents?: bigint;

    @Property({ type: 'timestamptz', nullable: true })
    processedAt?: Date;

    @Property({ type: 'timestamptz' })
    createdAt!: Date;
}