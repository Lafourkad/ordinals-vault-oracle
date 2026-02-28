export type { IVIn, IVOut, ITransactionData, IBlockData } from '@btc-vision/plugin-sdk';

/** Ord REST API response for GET /output/{txid}:{vout} */
export interface IOrdOutput {
    readonly inscriptions: readonly string[];
    readonly address: string | null;
    readonly script_pubkey: string;
    readonly transaction: string;
    readonly value: number;
}

/** A burn detected in a Bitcoin block, ready for contract submission */
export interface IVerifiedBurn {
    readonly inscriptionId: string;
    readonly burnerOpnetAddress: string;
    readonly blockHeight: number;
    readonly txid: string;
}

/** Oracle plugin config (from plugin.config.json) */
export interface IOracleConfig {
    /** Deployed OrdinalsVault contract address (op1q...) */
    readonly vaultContractAddress: string;
    /** Bitcoin address where inscriptions should be sent to burn (P2TR recommended) */
    readonly burnAddress: string;
    /** Local ord node URL, e.g. http://localhost:80 */
    readonly ordNodeUrl: string;
    /** OPNet JSON-RPC URL, e.g. https://mainnet.opnet.org/json-rpc */
    readonly opnetRpcUrl: string;
    /** Oracle private key WIF string (used to sign recordBurn transactions) */
    readonly oraclePrivateKeyWIF: string;
    /** Max satoshis the oracle may spend per recordBurn transaction */
    readonly maxSatToSpend: number;
    /** Bitcoin network identifier */
    readonly network: 'mainnet' | 'regtest';
}
