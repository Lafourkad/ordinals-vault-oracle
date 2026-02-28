import { PluginBase, type IBlockData } from '@btc-vision/plugin-sdk';
import type { IPluginContext, IReorgData } from '@btc-vision/plugin-sdk';
import { JSONRpcProvider } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { OrdClient } from './services/OrdClient.js';
import { BurnWatcher } from './services/BurnWatcher.js';
import { ContractCaller } from './services/ContractCaller.js';
import type { IOracleConfig, IVerifiedBurn } from './types/index.js';

/**
 * OrdinalsVault Oracle Plugin
 *
 * Watches every Bitcoin block for Ordinal burn transactions sent to a
 * configured `burnAddress`. For each detected burn:
 *
 * 1. Queries the local ord node to identify the burned inscription(s)
 * 2. Reads the burner's OPNet address from the `OP_RETURN` output
 * 3. Calls `recordBurn(inscriptionId, burner)` on the OrdinalsVault contract
 *
 * Burn transaction format (must be followed by wallets/dapps):
 * ```
 * vin[0]:  UTXO holding the inscription
 * vout[0]: <burnAddress>              ← inscription lands here
 * vout[1]: OP_RETURN <opnet_addr_32_bytes>  ← minting address
 * vout[2]: change (optional)
 * ```
 *
 * Plugin config (plugin.config.json):
 * ```json
 * {
 *   "vaultContractAddress": "op1q...",
 *   "burnAddress":          "bc1p...",
 *   "ordNodeUrl":           "http://localhost:80",
 *   "opnetRpcUrl":          "https://mainnet.opnet.org/json-rpc",
 *   "oraclePrivateKeyWIF":  "KwDiBf...",
 *   "maxSatToSpend":        10000,
 *   "network":              "mainnet"
 * }
 * ```
 */
export default class OrdinalsVaultOraclePlugin extends PluginBase {
    private ordClient!: OrdClient;
    private burnWatcher!: BurnWatcher;
    private contractCaller!: ContractCaller;
    private provider!: JSONRpcProvider;

    public override async onLoad(context: IPluginContext): Promise<void> {
        await super.onLoad(context);

        const config = this.context.config.get<IOracleConfig>('oracle');
        if (config === undefined) {
            throw new Error('OrdinalsVaultOracle: missing "oracle" config section');
        }

        const network = config.network === 'mainnet' ? networks.bitcoin : networks.regtest;

        this.provider = new JSONRpcProvider(config.opnetRpcUrl, network);
        this.ordClient = new OrdClient(config.ordNodeUrl);
        this.burnWatcher = new BurnWatcher(this.ordClient, config.burnAddress);
        this.contractCaller = new ContractCaller(config, network);

        this.context.logger.info(
            `OrdinalsVaultOracle loaded — watching burns to ${config.burnAddress}`,
        );

        if (this.context.db !== undefined) {
            await this.context.db
                .collection('oracle_burns')
                .createIndex({ burnTxid: 1 }, { unique: true });
            await this.context.db
                .collection('oracle_burns')
                .createIndex({ blockHeight: -1 });
        }
    }

    /**
     * Receives raw Bitcoin block data. Called before OPNet processes the block.
     *
     * This is where we detect burns: scan every TX output for the burn address,
     * then resolve inscriptions on the inputs via the local ord node.
     *
     * @param block - Raw Bitcoin block (Bitcoin Core `getblock` verbosity=2 format)
     */
    public override async onBlockPreProcess(block: IBlockData): Promise<void> {
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
            await this.submitBurn(burn);
        }
    }

    /**
     * CRITICAL: Chain reorganization handler.
     *
     * Must delete all burn records for reorged blocks to prevent
     * double-minting when the reorged blocks are re-processed.
     *
     * @param reorg - Reorg data (fromBlock = first reorged block height)
     */
    public override async onReorg(reorg: IReorgData): Promise<void> {
        this.context.logger.warn(
            `Reorg detected — purging burns from block ${reorg.fromBlock.toString()} onward`,
        );

        if (this.context.db !== undefined) {
            await this.context.db.collection('oracle_burns').deleteMany({
                blockHeight: { $gte: reorg.fromBlock },
            });
        }
    }

    public override async onUnload(): Promise<void> {
        this.context.logger.info('OrdinalsVaultOracle unloading');
        await this.provider.close();
        await super.onUnload();
    }

    // ─── Private Helpers ────────────────────────────────────────────────────────

    private async submitBurn(burn: IVerifiedBurn): Promise<void> {
        try {
            // Idempotency check — skip if already recorded in a previous run
            if (this.context.db !== undefined) {
                const existing = await this.context.db
                    .collection('oracle_burns')
                    .findOne({ burnTxid: burn.txid, inscriptionId: burn.inscriptionId });

                if (existing !== null) {
                    this.context.logger.debug(
                        `Already recorded: inscription=${burn.inscriptionId} txid=${burn.txid}`,
                    );
                    return;
                }
            }

            const recordTxid = await this.contractCaller.submitBurn(burn, this.provider);

            this.context.logger.info(
                `recordBurn OK — inscription=${burn.inscriptionId} burner=${burn.burnerOpnetAddress} recordTx=${recordTxid ?? 'unknown'}`,
            );

            if (this.context.db !== undefined) {
                await this.context.db.collection('oracle_burns').insertOne({
                    inscriptionId: burn.inscriptionId,
                    burnerOpnetAddress: burn.burnerOpnetAddress,
                    blockHeight: burn.blockHeight,
                    burnTxid: burn.txid,
                    recordTxid,
                    timestamp: Date.now(),
                });
            }
        } catch (err: unknown) {
            this.context.logger.error(
                `Failed to record burn for inscription ${burn.inscriptionId}: ${this.errMsg(err)}`,
            );
        }
    }

    private errMsg(err: unknown): string {
        return err instanceof Error ? err.message : String(err);
    }
}
