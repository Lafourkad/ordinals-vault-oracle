import type { IBlockData, ITransactionData, IVOut } from '@btc-vision/plugin-sdk';
import { OrdClient } from './OrdClient.js';
import type { IVerifiedBurn } from '../types/index.js';

/** OP_RETURN opcode prefix in hex */
const OP_RETURN_HEX = '6a';

/**
 * Length of the OPNet address payload in a burn OP_RETURN output.
 * 0x6a (OP_RETURN) + 0x20 (PUSH 32 bytes) + 32 bytes = 2 prefix chars + 4 len chars + 64 addr chars
 * Full hex: "6a20" + 64 hex chars = 68 chars total
 */
const BURN_OP_RETURN_HEX_LENGTH = 68;
const OPNET_ADDRESS_OFFSET = 4; // skip "6a20"

/**
 * Detects Ordinals burns in Bitcoin blocks and extracts inscription IDs.
 *
 * A valid burn transaction must have:
 * 1. An output to the configured `burnAddress` (inscription destination)
 * 2. An `OP_RETURN` output containing the burner's 32-byte OPNet address
 * 3. At least one input UTXO that holds an inscription (verified via local ord node)
 *
 * Burn TX structure:
 * ```
 * vin[0]:  UTXO holding the inscription
 * vout[0]: burnAddress output  ← inscription lands here
 * vout[1]: OP_RETURN <32-byte OPNet address>
 * vout[2]: change (optional)
 * ```
 */
export class BurnWatcher {
    private readonly ordClient: OrdClient;
    private readonly burnAddress: string;

    public constructor(ordClient: OrdClient, burnAddress: string) {
        this.ordClient = ordClient;
        this.burnAddress = burnAddress;
    }

    /**
     * Scans an entire Bitcoin block for valid burn transactions.
     *
     * @param block - Raw Bitcoin block data (`IBlockData` from `onBlockPreProcess`)
     * @returns All verified burns detected in this block
     */
    public async scanBlock(block: IBlockData): Promise<readonly IVerifiedBurn[]> {
        const burns: IVerifiedBurn[] = [];

        for (const tx of block.tx) {
            const result = await this.processTx(tx, block.height);
            if (result !== null) {
                burns.push(...result);
            }
        }

        return burns;
    }

    /**
     * Checks a single transaction for the burn pattern.
     *
     * @param tx - Raw Bitcoin transaction
     * @param blockHeight - Block height (number, as per IBlockData)
     * @returns Verified burns or null if this TX is not a burn
     */
    private async processTx(
        tx: ITransactionData,
        blockHeight: number,
    ): Promise<readonly IVerifiedBurn[] | null> {
        // Quick check: does this TX have an output to burnAddress?
        const hasBurnOutput = tx.vout.some(
            (out) => out.scriptPubKey.address === this.burnAddress,
        );
        if (!hasBurnOutput) {
            return null;
        }

        // Extract the burner's OPNet address from the OP_RETURN output
        const opnetAddress = this.extractOpnetAddress(tx.vout);
        if (opnetAddress === null) {
            return null;
        }

        // Query ord for inscriptions on each input UTXO
        const burns = await this.findInscriptionsInInputs(tx, blockHeight, opnetAddress);
        return burns.length > 0 ? burns : null;
    }

    /**
     * Extracts the burner's OPNet address from the OP_RETURN output.
     *
     * Expected OP_RETURN payload format (hex):
     * `6a20<64-hex-char OPNet address>`
     *   - `6a` = OP_RETURN opcode
     *   - `20` = PUSH 32 bytes
     *   - 64 hex chars = 32-byte OPNet address
     *
     * @param vouts - Transaction outputs
     * @returns OPNet address hex string, or null if not found
     */
    private extractOpnetAddress(vouts: readonly IVOut[]): string | null {
        for (const out of vouts) {
            const hex = out.scriptPubKey.hex;

            if (!hex.startsWith(OP_RETURN_HEX)) {
                continue;
            }

            if (hex.length !== BURN_OP_RETURN_HEX_LENGTH) {
                continue;
            }

            return hex.slice(OPNET_ADDRESS_OFFSET);
        }

        return null;
    }

    /**
     * Queries the local ord node for each input UTXO to discover inscriptions.
     *
     * @param tx - Raw Bitcoin transaction
     * @param blockHeight - Block height for the burn record
     * @param opnetAddress - Burner's OPNet address (hex)
     * @returns Verified burns from this transaction's inputs
     */
    private async findInscriptionsInInputs(
        tx: ITransactionData,
        blockHeight: number,
        opnetAddress: string,
    ): Promise<IVerifiedBurn[]> {
        const burns: IVerifiedBurn[] = [];

        for (const input of tx.vin) {
            // Skip coinbase inputs (txid is all zeros)
            if (input.txid === '0'.repeat(64)) {
                continue;
            }

            const output = await this.ordClient.getOutput(input.txid, input.vout);

            if (output === null || output.inscriptions.length === 0) {
                continue;
            }

            for (const inscriptionId of output.inscriptions) {
                burns.push({
                    inscriptionId,
                    burnerOpnetAddress: opnetAddress,
                    blockHeight,
                    txid: tx.txid,
                });
            }
        }

        return burns;
    }
}
