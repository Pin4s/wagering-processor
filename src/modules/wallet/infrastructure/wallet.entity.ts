import { Check, Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Unique({ name: 'wallets_player_currency_uq', properties: ['playerId', 'currency'] })
@Check({ name: 'wallets_balance_non_negative', expression: 'balance_cents >= 0' })
export class WalletEntity {
    @PrimaryKey({ type: 'uuid' })
    id!: string;

    @Property({ type: 'uuid' })
    playerId!: string;

    @Property({ columnType: 'char(3)' })
    currency!: string;

    @Property({ type: 'bigint' })
    balanceCents!: bigint;

    @Property()
    version!: number;

    @Property({ type: 'timestamptz' })
    createdAt!: Date;

    @Property({ type: 'timestamptz' })
    updatedAt!: Date;
}