export type { IVIn, IVOut, ITransactionData, IBlockData } from '@btc-vision/plugin-sdk';

/** Ord REST API response for GET /output/{txid}:{vout} */
export interface IOrdOutput {
    readonly inscriptions: readonly string[];
    readonly address: string | null;
    readonly script_pubkey: string;
    readonly value: number;
}

/** Ord REST API response for GET /tx/{txid} */
export interface IOrdTxInput {
    readonly txid: string | null;
    readonly vout: number | null;
    readonly coinbase: string | null;
    readonly sequence: number;
}

export interface IOrdTxOutput {
    readonly value: number;
    readonly script_pubkey: string;
    readonly address: string | null;
}

export interface IOrdTransaction {
    readonly txid: string;
    readonly version: number;
    readonly lock_time: number;
    readonly input: readonly IOrdTxInput[];
    readonly output: readonly IOrdTxOutput[];
}

/** A burn detected in a Bitcoin block, verified via local ord node */
export interface IVerifiedBurn {
    readonly inscriptionId: string;
    readonly burnerOpnetAddress: string; // 64-char hex, 32 bytes
    readonly blockHeight: number;
    readonly txid: string;
}

/**
 * Oracle attestation returned to the user.
 *
 * The user must pass `oraclePublicKey` + `oracleSig` to `recordBurnWithAttestation`.
 * `deadline` is an OPNet block height (tamper-proof, not a UNIX timestamp).
 */
export interface IAttestation {
    readonly txid: string;
    readonly inscriptionId: string;
    readonly burner: string;           // 64-char hex OPNet address (32 bytes)
    readonly deadline: number;         // OPNet block height — attestation valid until this block
    readonly nonce: string;            // 64-char hex, 32 random bytes (anti-replay)
    readonly oraclePublicKey: string;  // hex, 1312-byte ML-DSA-44 public key (for calldata)
    readonly oracleSig: string;        // hex, 2420-byte ML-DSA-44 signature
}

/** Oracle plugin config */
export interface IOracleConfig {
    /** Bitcoin address where inscriptions are sent to burn (P2TR recommended) */
    readonly burnAddress: string;
    /** Local ord node HTTP URL */
    readonly ordNodeUrl: string;
    /**
     * 64-char hex string (32 bytes entropy).
     * Deterministically derives the ML-DSA-44 keypair.
     * Keep this secret — it controls the oracle's signing authority.
     *
     * The corresponding oracle public key hash (sha256 of the 1312-byte public key)
     * must be registered in the contract via `_oracleKeyHash` at deployment or via `setOracle()`.
     */
    readonly oracleMLDSASeed: string;
    /** OPNet contract address (hex, 64 chars, no 0x prefix) — included in hash to prevent cross-contract replay */
    readonly vaultContractAddress: string;
    /** Attestation validity window in OPNet blocks (default: 144 ≈ 1 day at ~10 min/block) */
    readonly attestationTtlBlocks?: number;
    /**
     * Optional: restrict attestations to inscriptions from a specific BIS collection.
     *
     * If set, the oracle will query Best in Slot before signing any attestation.
     * Only inscriptions whose `collection_slug` matches this value will be attested.
     * Burns from other collections are stored in DB but rejected at attestation time.
     *
     * Example: "bitcoin-frogs"
     *
     * Leave unset for a universal bridge (any inscription accepted).
     */
    readonly collectionSlug?: string;
    /**
     * Optional: Best in Slot API key.
     *
     * Free tier allows ~3 req/sec without a key. Set this for higher throughput.
     * Get a key at https://bestinslot.xyz/account/api
     */
    readonly bisApiKey?: string;
}
