import { getContract } from 'opnet';
import type { CallResult } from 'opnet';
import type { IOP_NETContract } from 'opnet';
import type { TransactionParameters } from 'opnet';
import { BitcoinAbiTypes } from 'opnet';
import {
    ABIDataTypes,
    Address,
    EcKeyPair,
    TweakedSigner,
} from '@btc-vision/transaction';
import type { BitcoinInterfaceAbi } from 'opnet';
import type { Network } from '@btc-vision/bitcoin';
import type { IVerifiedBurn, IOracleConfig } from '../types/index.js';

// ─── Contract ABI ─────────────────────────────────────────────────────────────

const RECORD_BURN_ABI: BitcoinInterfaceAbi = [
    {
        name: 'recordBurn',
        type: BitcoinAbiTypes.Function,
        inputs: [
            { name: 'inscriptionId', type: ABIDataTypes.STRING },
            { name: 'burner', type: ABIDataTypes.ADDRESS },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
    },
];

// ─── Contract Interface ────────────────────────────────────────────────────────

type RecordBurnResult = CallResult<{ success: boolean }, []>;

interface IOrdinalsVaultOracle extends IOP_NETContract {
    recordBurn(inscriptionId: string, burner: Address): Promise<RecordBurnResult>;
}

// ─── ContractCaller ───────────────────────────────────────────────────────────

/**
 * Calls `recordBurn()` on the deployed OrdinalsVault contract.
 *
 * Uses the oracle's WIF private key to sign each transaction.
 * The oracle must be the deployer (or a whitelisted oracle address) of the vault.
 */
export class ContractCaller {
    private readonly config: IOracleConfig;
    private readonly network: Network;

    public constructor(config: IOracleConfig, network: Network) {
        this.config = config;
        this.network = network;
    }

    /**
     * Simulates and broadcasts a `recordBurn` call.
     *
     * @param burn - Verified burn data
     * @param rpcProvider - JSON-RPC provider instance
     * @returns Broadcast transaction ID (`transactionId`), or null
     * @throws If simulation fails (already burned, wrong oracle, etc.)
     */
    public async submitBurn(
        burn: IVerifiedBurn,
        rpcProvider: import('opnet').JSONRpcProvider,
    ): Promise<string | null> {
        const contract = getContract<IOrdinalsVaultOracle>(
            this.config.vaultContractAddress,
            RECORD_BURN_ABI,
            rpcProvider,
            this.network,
        );

        // Convert 32-byte hex OPNet address → Address object
        const burnerAddress = new Address(Buffer.from(burn.burnerOpnetAddress, 'hex'));

        const sim = await contract.recordBurn(burn.inscriptionId, burnerAddress);

        if ('error' in sim) {
            throw new Error(
                `Simulation rejected: inscription=${burn.inscriptionId} error=${String(sim.error)}`,
            );
        }

        // Build tweaked Taproot signer from oracle WIF key
        const rawKeypair = EcKeyPair.fromWIF(this.config.oraclePrivateKeyWIF, this.network);
        const signer = TweakedSigner.tweakSigner(rawKeypair, { network: this.network });
        const refundTo = EcKeyPair.getTaprootAddress(rawKeypair, this.network);

        const txParams: TransactionParameters = {
            signer,
            mldsaSigner: null,
            refundTo,
            maximumAllowedSatToSpend: BigInt(this.config.maxSatToSpend),
            network: this.network,
        };

        const receipt = await sim.sendTransaction(txParams);

        if ('error' in receipt) {
            throw new Error(`Broadcast failed: ${String(receipt.error)}`);
        }

        return receipt.transactionId ?? null;
    }
}
