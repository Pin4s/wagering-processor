import { BadRequestException, Body, ConflictException, Controller, Inject, Post } from '@nestjs/common';
import { InvalidMoneyError } from '../../../shared/domain/money';
import { CreateWalletInput, CreateWalletUseCase, WalletAlreadyExistsError } from '../application/create-wallet.use-case';
import { isUuid } from '../../../shared/is-uuid';

interface CreateWalletBody {
    playerId?: unknown;
    initialBalance?: { amount?: unknown; currency?: unknown } | null;
}

@Controller('wallets')
export class WalletController {
    constructor(@Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase) { }

    @Post()
    async create(@Body() body: CreateWalletBody) {
        const input = parseCreateWalletBody(body);

        try {
            const wallet = await this.createWallet.execute(input);
            return {
                id: wallet.id,
                playerId: wallet.playerId,
                balance: wallet.balance.toJSON(),
                version: wallet.version,
            };
        } catch (error) {
            if (error instanceof InvalidMoneyError) {
                throw invalidPayload(error.message);
            }
            if (error instanceof WalletAlreadyExistsError) {
                throw new ConflictException({ error: 'WALLET_ALREADY_EXISTS', message: error.message });
            }
            throw error;
        }
    }
}

function parseCreateWalletBody(body: CreateWalletBody): CreateWalletInput {
    if (!isUuid(body.playerId)) {
        throw invalidPayload('playerId must be a UUID');
    }

    const { playerId, initialBalance } = body as Record<string, unknown>;

    if (!isUuid(playerId)) {
        throw invalidPayload('playerId must be a UUID');
    }
    if (typeof initialBalance !== 'object' || initialBalance === null) {
        throw invalidPayload('initialBalance is required');
    }

    const amount = body.initialBalance?.amount;
    const currency = body.initialBalance?.currency;

    if (typeof amount !== 'string' || typeof currency !== 'string') {
        throw invalidPayload('initialBalance must have amount and currency as strings');
    }

    return { playerId: body.playerId, initialBalance: { amount, currency } };
}

function invalidPayload(message: string): BadRequestException {
    return new BadRequestException({ error: 'INVALID_PAYLOAD', message });
}