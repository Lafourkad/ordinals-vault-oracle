import { PluginBase } from '@btc-vision/plugin-sdk';
import type {
    IBlockData,
    IMempoolTransaction,
    IPluginContext,
    IPluginHttpRequest,
    IPluginRouter,
    IReorgData,
} from '@btc-vision/plugin-sdk';
import { OrdClient } from './services/OrdClient.js';
import { BurnWatcher } from './services/BurnWatcher.js';
import { AttestationSigner } from './services/AttestationSigner.js';
import type { IAttestation, IOracleConfig, IVerifiedBurn } from './types/index.js';

/** MongoDB collection name for detected burns */
const BURNS_COLLECTION = 'oracle_burns';

type HandlerResult<T> = T | { readonly error: string };

/**
 * OrdinalsVault Oracle Plugin — Gasless Edition
 *
 * This plugin has two responsibilities:
 *
 * 1. WATCH blocks for Ordinal burns (onBlockPreProcess).
 *    Scans every Bitcoin TX for outputs to `burnAddress`. Reads the burner's
 *    OPNet address from the OP_RETURN output. Verifies inscriptions via the
 *    local ord node. Stores detected burns in MongoDB.
 *
 * 2. SERVE attestations via HTTP (GET /attestation/:txid).
 *    When a user requests an attestation for their burn TX, the oracle signs
 *    it off-chain using ML-DSA-44 (FIPS 204, post-quantum) and returns the signature.
 *    The user submits it to the contract themselves — oracle pays ZERO gas.
 *
 * Plugin config (plugin.config.json):
 * ```json
 * {
 *   "oracle": {
 *     "burnAddress":           "bc1p...",
 *     "ordNodeUrl":            "http://localhost:80",
 *     "vaultContractAddress":  "64hexchars",
 *     "oracleMLDSASeed":       "64hexchars",
 *     "attestationTtlBlocks":  144
 *   }
 * }
 * ```
 */
export default class OrdinalsVaultOraclePlugin extends PluginBase {
    private ordClient!: OrdClient;
    private burnWatcher!: BurnWatcher;
    private attestationSigner!: AttestationSigner;

    /** Latest known OPNet block height — updated on every block. */
    private currentBlockHeight: number = 0;

    /** Unix timestamp (ms) when the plugin was loaded — for uptime tracking. */
    private startedAt: number = 0;

    /**
     * Txids seen in the mempool that sent to the burn address.
     * We can't inspect full TX structure from the mempool hook (SDK only gives txid),
     * so we store all txids seen in mempool and let scanBlock confirm them when the
     * block arrives. This set also drives the health endpoint's "pending" count.
     * Cleared after each block (confirmed txids are now in DB).
     */
    private readonly mempoolWatched: Set<string> = new Set();

    public override async onLoad(context: IPluginContext): Promise<void> {
        await super.onLoad(context);
        this.startedAt = Date.now();

        const config = this.context.config.get<IOracleConfig>('oracle');
        if (config === undefined) {
            throw new Error('OrdinalsVaultOracle: missing "oracle" config section');
        }

        this.ordClient = new OrdClient(config.ordNodeUrl);
        this.burnWatcher = new BurnWatcher(this.ordClient, config.burnAddress);
        this.attestationSigner = new AttestationSigner(
            config.oracleMLDSASeed,
            config.vaultContractAddress,
            config.attestationTtlBlocks ?? 144,
        );

        this.context.logger.info(
            `OrdinalsVaultOracle: ML-DSA-44 oracle loaded. ` +
            `Public key hash (register in contract): ${this.attestationSigner.publicKeyHash}`,
        );

        if (this.context.db !== undefined) {
            await this.context.db
                .collection(BURNS_COLLECTION)
                .createIndex({ burnTxid: 1 }, { unique: true });
            await this.context.db
                .collection(BURNS_COLLECTION)
                .createIndex({ blockHeight: -1 });
        }

        this.context.logger.info(
            `OrdinalsVaultOracle loaded — watching burns to ${config.burnAddress} (gasless ML-DSA-44 mode)`,
        );
    }

    /**
     * Registers REST endpoints on the OPNet node.
     *
     * Available routes:
     *   GET /attestation/:txid   — Returns a signed attestation for a burn TX
     *   GET /burns               — Lists all detected burns (for debugging)
     */
    public override registerRoutes(router: IPluginRouter): void {
        router.get('/health', 'handleHealth');
        router.get('/attestation/:txid', 'handleGetAttestation');
        router.get('/burns', 'handleListBurns');
    }

    /**
     * Scans raw Bitcoin blocks for Ordinal burns.
     *
     * Detected burns are stored in MongoDB. They become available for
     * attestation signing immediately after detection.
     *
     * @param block - Raw Bitcoin block data
     */
    /**
     * Called by the OPNet node for each transaction entering the mempool.
     *
     * We only receive the txid here (no vout/vin data). We store it in
     * `mempoolWatched` so the health endpoint can report pending activity.
     * Actual burn detection happens in `onBlockPreProcess` once confirmed.
     */
    public override async onMempoolTransaction(tx: IMempoolTransaction): Promise<void> {
        this.mempoolWatched.add(tx.txid);
    }

    public override async onBlockPreProcess(block: IBlockData): Promise<void> {
        this.currentBlockHeight = block.height;
        // Clear mempool watch set — confirmed txids are now processed by scanBlock
        this.mempoolWatched.clear();

        let burns: readonly IVerifiedBurn[];

        try {
            burns = await this.burnWatcher.scanBlock(block);
        } catch (err: unknown) {
            this.context.logger.error(
                `Block ${block.height.toString()} scan error: ${this.errMsg(err)}`,
            );
            return;
        }

        if (burns.length === 0) {
            return;
        }

        this.context.logger.info(
            `Block ${block.height.toString()}: ${burns.length.toString()} burn(s) detected`,
        );

        for (const burn of burns) {
            await this.storeBurn(burn);
        }
    }

    /**
     * Handles chain reorganizations.
     *
     * Deletes stored burns from reorged blocks so they don't get re-attested
     * with stale data. Burns will be re-detected when the new chain is processed.
     *
     * @param reorg - Reorg data (fromBlock = first reorged block)
     */
    public override async onReorg(reorg: IReorgData): Promise<void> {
        this.context.logger.warn(
            `Reorg: purging burns from block ${reorg.fromBlock.toString()} onward`,
        );

        if (this.context.db !== undefined) {
            await this.context.db
                .collection(BURNS_COLLECTION)
                .deleteMany({ blockHeight: { $gte: reorg.fromBlock } });
        }
    }

    public override async onUnload(): Promise<void> {
        this.context.logger.info('OrdinalsVaultOracle unloading');
        await super.onUnload();
    }

    // ─── HTTP Handlers ───────────────────────────────────────────────────────────

    /**
     * Health check endpoint. Call this before showing the burn UI.
     *
     * Response:
     * ```json
     * {
     *   "status": "ok",
     *   "currentBlockHeight": 850000,
     *   "uptimeSeconds": 3600,
     *   "burnsDetected": 42,
     *   "mempoolWatched": 3,
     *   "oraclePublicKeyHash": "64hexchars",
     *   "db": true
     * }
     * ```
     *
     * `status` is "ok" when the oracle is operational.
     * `status` is "degraded" when the database is unavailable (burns cannot be stored).
     *
     * ⚠️  A successful health check does NOT guarantee the oracle will still be
     * online when your burn confirms. Attestations are valid for `ttlBlocks` OPNet
     * blocks (~24h at default settings), so the oracle can go offline briefly after
     * your burn and you can still claim once it comes back.
     */
    public async handleHealth(_request: IPluginHttpRequest): Promise<object> {
        const dbOk = this.context.db !== undefined;
        let burnsDetected = 0;

        if (dbOk) {
            try {
                burnsDetected = await this.context.db!
                    .collection(BURNS_COLLECTION)
                    .countDocuments();
            } catch {
                // non-fatal
            }
        }

        return {
            status: dbOk ? 'ok' : 'degraded',
            currentBlockHeight: this.currentBlockHeight,
            uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
            burnsDetected,
            mempoolWatched: this.mempoolWatched.size,
            oraclePublicKeyHash: this.attestationSigner.publicKeyHash,
            db: dbOk,
        };
    }

    /**
     * Returns a signed oracle attestation for a confirmed burn transaction.
     *
     * The user fetches this and submits it to the contract via
     * `recordBurnWithAttestation(inscriptionId, burner, deadline, nonce, sig)`.
     *
     * Each request generates a fresh nonce + signature. Multiple valid
     * attestations can exist for the same burn — only the first one submitted
     * on-chain consumes a nonce (others remain valid until their deadline).
     *
     * Response:
     * ```json
     * {
     *   "txid": "abc...",
     *   "inscriptionId": "abc...i0",
     *   "burner": "64hexchars",
     *   "deadline": 1700000000,
     *   "nonce": "64hexchars",
     *   "oracleSig": "128hexchars"
     * }
     * ```
     *
     * @param request - HTTP request with txid param
     */
    public async handleGetAttestation(
        request: IPluginHttpRequest,
    ): Promise<HandlerResult<IAttestation>> {
        const txid = request.params['txid'];

        if (txid === undefined || txid.length !== 64) {
            return { error: 'Invalid txid — must be a 64-char hex string' };
        }

        if (this.context.db === undefined) {
            return { error: 'Database not available' };
        }

        const burn = await this.context.db
            .collection(BURNS_COLLECTION)
            .findOne({ burnTxid: txid });

        if (burn === null) {
            return {
                error: 'Burn not found — TX not detected yet or not a valid burn transaction',
            };
        }

        const verifiedBurn: IVerifiedBurn = {
            inscriptionId: burn['inscriptionId'] as string,
            burnerOpnetAddress: burn['burnerOpnetAddress'] as string,
            blockHeight: burn['blockHeight'] as number,
            txid: burn['burnTxid'] as string,
        };

        try {
            return this.attestationSigner.sign(verifiedBurn, this.currentBlockHeight);
        } catch (err: unknown) {
            this.context.logger.error(`Attestation signing failed: ${this.errMsg(err)}`);
            return { error: 'Attestation signing failed' };
        }
    }

    /**
     * Lists all detected burns (paginated, newest first). For debugging/UX.
     *
     * Query params:
     *   limit  — max results (default 50, max 200)
     *   offset — skip N results
     *
     * @param request - HTTP request with optional query params
     */
    public async handleListBurns(
        request: IPluginHttpRequest,
    ): Promise<HandlerResult<{ readonly burns: unknown[]; readonly total: number }>> {
        if (this.context.db === undefined) {
            return { error: 'Database not available' };
        }

        const limit = Math.min(Number(request.query['limit'] ?? 50), 200);
        const offset = Number(request.query['offset'] ?? 0);

        const [burns, total] = await Promise.all([
            this.context.db
                .collection(BURNS_COLLECTION)
                .find({})
                .sort({ blockHeight: -1 })
                .skip(offset)
                .limit(limit)
                .toArray(),
            this.context.db.collection(BURNS_COLLECTION).countDocuments(),
        ]);

        return { burns, total };
    }

    // ─── Private Helpers ─────────────────────────────────────────────────────────

    private async storeBurn(burn: IVerifiedBurn): Promise<void> {
        if (this.context.db === undefined) {
            return;
        }

        try {
            await this.context.db.collection(BURNS_COLLECTION).insertOne({
                burnTxid: burn.txid,
                inscriptionId: burn.inscriptionId,
                burnerOpnetAddress: burn.burnerOpnetAddress,
                blockHeight: burn.blockHeight,
                detectedAt: Date.now(),
            });

            this.context.logger.info(
                `Stored burn — inscription=${burn.inscriptionId} burner=${burn.burnerOpnetAddress}`,
            );
        } catch (err: unknown) {
            // Duplicate key = already stored, safe to ignore
            if (this.errMsg(err).includes('duplicate') || this.errMsg(err).includes('E11000')) {
                return;
            }
            this.context.logger.error(`Failed to store burn: ${this.errMsg(err)}`);
        }
    }

    private errMsg(err: unknown): string {
        return err instanceof Error ? err.message : String(err);
    }
}
