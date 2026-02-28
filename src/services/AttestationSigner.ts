import { randomBytes, createHash } from 'crypto';
import { ml_dsa44 } from '@btc-vision/post-quantum/ml-dsa.js';
import type { IAttestation, IVerifiedBurn } from '../types/index.js';

/**
 * Signs oracle attestations using ML-DSA-44 (FIPS 204 post-quantum signatures).
 *
 * The oracle never submits OPNet transactions. Instead, it signs attestations
 * off-chain. Users fetch attestations and submit them to the contract themselves,
 * paying their own gas.
 *
 * Hash layout (must match contract's `buildAttestationHash` exactly):
 *   sha256(
 *     contractAddress (32 bytes)
 *     | inscriptionId_len (4 bytes, uint32 big-endian)
 *     | inscriptionId (UTF-8 bytes)
 *     | burner (32 bytes)
 *     | deadline (8 bytes, uint64 big-endian — BLOCK HEIGHT, not timestamp)
 *     | nonce (32 bytes)
 *     | collectionIdHash (32 bytes, u256 big-endian)
 *   )
 */
export class AttestationSigner {
    /** ML-DSA-44 2560-byte secret key derived from seed. */
    private readonly secretKey: Uint8Array;

    /** ML-DSA-44 1312-byte public key. Passed to users as calldata for `recordBurnWithAttestation`. */
    public readonly publicKey: Uint8Array;

    /**
     * sha256(publicKey) as hex — this is what the contract stores as `_oracleKeyHash`.
     * Register this value when deploying the contract.
     */
    public readonly publicKeyHash: string;

    /** Contract address (64-char hex, no prefix). Used in attestation hash construction. */
    private readonly contractAddress: string;

    /** Attestation lifetime in OPNet blocks (deadline = currentBlock + ttlBlocks). */
    private readonly ttlBlocks: number;

    /**
     * sha256(collectionSlug) as 64-char hex string (32 bytes).
     * Included in every attestation hash to bind signatures to a specific collection.
     * Set to '00'.repeat(32) for universal mode (any inscription).
     */
    private readonly collectionIdHash: string;

    /**
     * @param oracleMLDSASeed     - 64-char hex string (32 bytes entropy). Deterministically
     *                              derives the ML-DSA-44 keypair. Keep this secret — it controls
     *                              the oracle's signing authority.
     * @param contractAddress     - OPNet contract address (hex, 64 chars, no 0x prefix).
     * @param ttlBlocks           - Attestation TTL in blocks (default 144 ≈ 1 day at ~10 min/block).
     * @param collectionIdHash    - sha256(collectionSlug) as hex, or all-zeros for universal.
     */
    public constructor(
        oracleMLDSASeed: string,
        contractAddress: string,
        ttlBlocks: number = 144,
        collectionIdHash: string = '0'.repeat(64),
    ) {
        if (oracleMLDSASeed.length !== 64) {
            throw new Error(
                'AttestationSigner: oracleMLDSASeed must be a 64-char hex string (32 bytes)',
            );
        }

        // Derive keypair deterministically from seed.
        // ML-DSA keygen accepts an optional 32-byte seed for deterministic key generation.
        const seed = hexToBytes(oracleMLDSASeed);
        const kp = ml_dsa44.keygen(seed);
        this.secretKey = kp.secretKey; // 2560 bytes
        this.publicKey = kp.publicKey; // 1312 bytes

        this.publicKeyHash = bytesToHex(
            new Uint8Array(createHash('sha256').update(this.publicKey).digest()),
        );

        this.contractAddress = contractAddress.replace(/^0x/, '').toLowerCase();
        this.ttlBlocks = ttlBlocks;
        this.collectionIdHash = collectionIdHash.replace(/^0x/, '').toLowerCase();
    }

    /**
     * Creates and signs an attestation for a verified burn.
     *
     * A fresh nonce is generated on every call — attestations are stateless.
     * The user submits any valid attestation to the contract; once the nonce
     * is consumed on-chain, future attestations for the same burn still work
     * because they use different nonces.
     *
     * The deadline is expressed as an OPNet block height (tamper-proof).
     * `currentBlockHeight + ttlBlocks` sets the window during which the
     * attestation remains valid on-chain.
     *
     * @param burn               - Verified burn from the block watcher.
     * @param currentBlockHeight - Current OPNet block height (from onBlockPreProcess).
     * @returns Signed attestation ready for the user to submit.
     */
    public sign(burn: IVerifiedBurn, currentBlockHeight: number): IAttestation {
        const nonce = randomBytes(32);
        const deadline = currentBlockHeight + this.ttlBlocks;

        const hash = this.buildHash(
            burn.inscriptionId,
            burn.burnerOpnetAddress,
            deadline,
            nonce,
        );

        // ml_dsa44.sign(message, secretKey) — message is first argument
        const sig = ml_dsa44.sign(hash, this.secretKey);

        return {
            txid: burn.txid,
            inscriptionId: burn.inscriptionId,
            burner: burn.burnerOpnetAddress,
            deadline,
            nonce: bytesToHex(nonce),
            collectionIdHash: this.collectionIdHash,
            oraclePublicKey: bytesToHex(this.publicKey),
            oracleSig: bytesToHex(sig),
        };
    }

    /**
     * Builds the attestation hash.
     *
     * This must produce the same bytes as the AssemblyScript contract's
     * `buildAttestationHash(inscriptionId, burner, deadline, nonce)`.
     *
     * BytesWriter field sizes (matching btc-runtime):
     *   writeAddress → 32 bytes (raw address bytes)
     *   writeU32     → 4 bytes big-endian
     *   writeBytes   → raw bytes
     *   writeU64     → 8 bytes big-endian (BLOCK HEIGHT)
     *   writeU256    → 32 bytes big-endian
     */
    private buildHash(
        inscriptionId: string,
        burnerHex: string, // 64-char hex (32-byte OPNet address)
        deadline: number,  // OPNet block height
        nonce: Uint8Array, // 32 bytes random
    ): Uint8Array {
        const contractBytes = hexToBytes(this.contractAddress);
        const inscBytes = textEncode(inscriptionId);
        const burnerBytes = hexToBytes(burnerHex);
        const collectionBytes = hexToBytes(this.collectionIdHash);

        // inscriptionId length as 4-byte big-endian uint32
        const lenBytes = new Uint8Array(4);
        new DataView(lenBytes.buffer).setUint32(0, inscBytes.length, false);

        // deadline (block height) as 8-byte big-endian uint64
        const deadlineBytes = new Uint8Array(8);
        new DataView(deadlineBytes.buffer).setBigUint64(0, BigInt(deadline), false);

        // nonce as 32 bytes (already Uint8Array)
        // collectionIdHash as 32 bytes (u256 big-endian)
        const message = concatBytes(
            contractBytes,
            lenBytes,
            inscBytes,
            burnerBytes,
            deadlineBytes,
            nonce,
            collectionBytes,
        );

        return new Uint8Array(createHash('sha256').update(message).digest());
    }
}

// ─── Uint8Array helpers (no Buffer) ──────────────────────────────────────────

/**
 * Decodes a hex string into a Uint8Array.
 * @param hex - Even-length hex string (no 0x prefix).
 */
function hexToBytes(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd-length hex string');
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

/**
 * Encodes a Uint8Array as a lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Encodes a string as UTF-8 Uint8Array.
 */
function textEncode(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

/**
 * Concatenates multiple Uint8Array chunks into one.
 */
function concatBytes(...chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}
