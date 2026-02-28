import { createHash, randomBytes } from 'crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { EcKeyPair } from '@btc-vision/transaction';
import type { Network } from '@btc-vision/bitcoin';
import type { IAttestation, IVerifiedBurn } from '../types/index.js';

/**
 * Signs oracle attestations using BIP340 Schnorr signatures.
 *
 * The oracle never submits OPNet transactions. Instead, it signs attestations
 * off-chain. Users fetch attestations and submit them to the contract themselves,
 * paying their own gas.
 *
 * Hash layout (must match contract's `buildAttestationHash` exactly):
 *   sha256(
 *     contractAddress (32 bytes, raw hex)
 *     | inscriptionId_len (4 bytes, uint32 big-endian)
 *     | inscriptionId (UTF-8 bytes)
 *     | burner (32 bytes, raw hex)
 *     | deadline (8 bytes, uint64 big-endian)
 *     | nonce (32 bytes)
 *   )
 */
export class AttestationSigner {
    private readonly privateKey: Uint8Array;
    private readonly contractAddress: string; // 64-char hex (no prefix)
    private readonly ttlSeconds: number;

    public constructor(
        oraclePrivateKeyWIF: string,
        contractAddress: string,
        network: Network,
        ttlSeconds: number = 3600,
    ) {
        const keypair = EcKeyPair.fromWIF(oraclePrivateKeyWIF, network);

        if (keypair.privateKey === undefined) {
            throw new Error('AttestationSigner: could not extract private key from WIF');
        }

        this.privateKey = keypair.privateKey;
        this.contractAddress = contractAddress.replace(/^0x/, '').toLowerCase();
        this.ttlSeconds = ttlSeconds;
    }

    /**
     * Creates and signs an attestation for a verified burn.
     *
     * A fresh nonce is generated on every call — attestations are stateless.
     * The user submits any valid attestation to the contract; once the nonce
     * is consumed on-chain, future attestations for the same burn still work
     * because they use different nonces.
     *
     * @param burn - Verified burn from the block watcher
     * @returns Signed attestation ready for the user to submit
     */
    public sign(burn: IVerifiedBurn): IAttestation {
        const nonce = randomBytes(32);
        const deadline = Math.floor(Date.now() / 1000) + this.ttlSeconds;

        const hash = this.buildHash(
            burn.inscriptionId,
            burn.burnerOpnetAddress,
            deadline,
            nonce,
        );

        const sig = schnorr.sign(hash, this.privateKey);

        return {
            txid: burn.txid,
            inscriptionId: burn.inscriptionId,
            burner: burn.burnerOpnetAddress,
            deadline,
            nonce: Buffer.from(nonce).toString('hex'),
            oracleSig: Buffer.from(sig).toString('hex'),
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
     *   writeU64     → 8 bytes big-endian
     *   writeU256    → 32 bytes big-endian
     */
    private buildHash(
        inscriptionId: string,
        burnerHex: string, // 64-char hex
        deadline: number,
        nonce: Uint8Array, // 32 bytes
    ): Uint8Array {
        const contractBytes = Buffer.from(this.contractAddress, 'hex');
        const inscBytes = Buffer.from(inscriptionId, 'utf8');
        const burnerBytes = Buffer.from(burnerHex, 'hex');

        const lenBytes = Buffer.alloc(4);
        lenBytes.writeUInt32BE(inscBytes.length, 0);

        const deadlineBytes = Buffer.alloc(8);
        deadlineBytes.writeBigUInt64BE(BigInt(deadline), 0);

        const nonceBytes = Buffer.from(nonce);

        const message = Buffer.concat([
            contractBytes,
            lenBytes,
            inscBytes,
            burnerBytes,
            deadlineBytes,
            nonceBytes,
        ]);

        return new Uint8Array(createHash('sha256').update(message).digest());
    }
}
