import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { InvalidMoneyError } from '../../../shared/domain/money';
import { CreateWalletInput, CreateWalletUseCase, WalletAlreadyExistsError } from '../application/create-wallet.use-case';
import { isUuid } from '../../../shared/is-uuid';
import { WalletQueriesService, type LedgerCursor } from '../application/wallet-queries.service';
import { WalletNotFoundError } from '../../wagering/application/process-wager-transaction.use-case';

interface CreateWalletBody {
    playerId?: unknown;
    initialBalance?: { amount?: unknown; currency?: unknown } | null;
}

interface LedgerQuery {
    cursor?: unknown;
    limit?: unknown;
}

@Controller('wallets')
export class WalletController {
    constructor(
        @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
        @Inject(WalletQueriesService) private readonly queries: WalletQueriesService,
    ) { }

    @Get(':walletId')
    async get(@Param('walletId') walletId: string) {
        validateWalletId(walletId);
        try {
            return await this.queries.getWallet(walletId);
        } catch (error) {
            throw toQueryHttpError(error);
        }
    }

    @Get(':walletId/ledger')
    async ledger(@Param('walletId') walletId: string, @Query() query: LedgerQuery) {
        validateWalletId(walletId);
        const limit = parseLimit(query.limit);
        const cursor = parseCursor(query.cursor);
        try {
            return await this.queries.getLedger(walletId, limit, cursor);
        } catch (error) {
            throw toQueryHttpError(error);
        }
    }

    @Post(':walletId/reconciliation')
    @HttpCode(200)
    async reconcile(@Param('walletId') walletId: string) {
        validateWalletId(walletId);
        try {
            return await this.queries.reconcile(walletId);
        } catch (error) {
            throw toQueryHttpError(error);
        }
    }

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
    if (typeof body !== 'object' || body === null) {
        throw invalidPayload('body is required');
    }
    if (!isUuid(body.playerId)) {
        throw invalidPayload('playerId must be a UUID');
    }

    if (typeof body.initialBalance !== 'object' || body.initialBalance === null) {
        throw invalidPayload('initialBalance is required');
    }

    const amount = body.initialBalance?.amount;
    const currency = body.initialBalance?.currency;

    if (typeof amount !== 'string' || typeof currency !== 'string') {
        throw invalidPayload('initialBalance must have amount and currency as strings');
    }

    return { playerId: body.playerId, initialBalance: { amount, currency } };
}

function validateWalletId(walletId: string): void {
    if (!isUuid(walletId)) {
        throw invalidPayload('walletId must be a UUID');
    }
}

function parseLimit(value: unknown): number {
    if (value === undefined) {
        return 50;
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw invalidPayload('limit must be an integer between 1 and 100');
    }
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw invalidPayload('limit must be an integer between 1 and 100');
    }
    return limit;
}

function parseCursor(value: unknown): LedgerCursor | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw invalidPayload('cursor is invalid');
    }
    const buffer = Buffer.from(value, 'base64url');
    if (buffer.toString('base64url') !== value) {
        throw invalidPayload('cursor is invalid');
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(buffer.toString('utf8'));
    } catch {
        throw invalidPayload('cursor is invalid');
    }
    if (
        typeof decoded !== 'object' || decoded === null ||
        !('createdAt' in decoded) || typeof decoded.createdAt !== 'string' ||
        !('id' in decoded) || !isUuid(decoded.id)
    ) {
        throw invalidPayload('cursor is invalid');
    }
    const createdAt = new Date(decoded.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== decoded.createdAt) {
        throw invalidPayload('cursor is invalid');
    }
    return { createdAt, id: decoded.id };
}

function toQueryHttpError(error: unknown): unknown {
    if (error instanceof WalletNotFoundError) {
        return new NotFoundException({ error: 'WALLET_NOT_FOUND', message: error.message });
    }
    return error;
}

function invalidPayload(message: string): BadRequestException {
    return new BadRequestException({ error: 'INVALID_PAYLOAD', message });
}
