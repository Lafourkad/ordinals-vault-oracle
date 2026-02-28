export type { IVIn, IVOut, ITransactionData, IBlockData } from '@btc-vision/plugin-sdk';

/** Ord REST API response for GET /output/{txid}:{vout} */
export interface IOrdOutput {
    readonly inscriptions: readonly string[];
    readonly address: string | null;
    readonly script_pubkey: string;
    readonly value: number;
}

/** A burn detected in a Bitcoin block, verified via local ord node */
export interface IVerifiedBurn {
    readonly inscriptionId: string;
    readonly burnerOpnetAddress: string; // 64-char hex, 32 bytes
    readonly blockHeight: number;
    readonly txid: string;
}

/** Oracle attestation returned to the user */
export interface IAttestation {
    readonly txid: string;
    readonly inscriptionId: string;
    readonly burner: string;       // 64-char hex OPNet address
    readonly deadline: number;     // UNIX timestamp (seconds) — block.medianTime deadline
    readonly nonce: string;        // 64-char hex, 32 random bytes
    readonly oracleSig: string;    // 128-char hex, 64-byte Schnorr signature
}

/** Oracle plugin config */
export interface IOracleConfig {
    /** Bitcoin address where inscriptions are sent to burn (P2TR recommended) */
    readonly burnAddress: string;
    /** Local ord node HTTP URL */
    readonly ordNodeUrl: string;
    /** Attestation validity window in seconds (default: 3600 = 1 hour) */
    readonly attestationTtlSeconds?: number;
    /** Oracle secp256k1 private key WIF — used for off-chain Schnorr signing */
    readonly oraclePrivateKeyWIF: string;
    /** Bitcoin network */
    readonly network: 'mainnet' | 'regtest';
    /** OPNet contract address — included in hash to prevent cross-contract replay */
    readonly vaultContractAddress: string;
}
