# ordinals-vault-oracle

An [OPNet](https://opnet.org) node plugin that acts as a gasless bridge oracle for [OrdinalsVault](https://github.com/Lafourkad/ordinals-vault).

Watches every Bitcoin block for Ordinal burn transactions, verifies them against a local `ord` node, and serves signed ML-DSA-44 attestations via REST. Users fetch attestations and submit them to the contract themselves — **the oracle pays zero gas and never touches OPNet transactions**.

---

## How It Works

### Three-Step Gasless Bridge

**Step 1 — Burn (Bitcoin, user)**

The user sends a Bitcoin transaction that burns their inscription:

```
vin[0]:   UTXO holding the inscription
vout[0]:  <burnAddress>                        ← inscription is sent here
vout[1]:  OP_RETURN <opnet_address_32_bytes>   ← OPNet address that will receive the mint
vout[2]:  change (optional)
```

The 32-byte OPNet address in `OP_RETURN` locks the future mint to that specific OPNet account.

**Step 2 — Attest (Oracle, gasless)**

The oracle detects the burn, verifies the inscription via the local `ord` node, and signs an attestation **off-chain** using ML-DSA-44 (FIPS 204, post-quantum). The signature is served via REST:

```
GET /plugins/ordinals-oracle/attestation/:txid
→ { inscriptionId, burner, deadline, nonce, oraclePublicKey, oracleSig }
```

The oracle never submits an OPNet transaction. It only signs.

**Step 3 — Claim + Mint (User, pays own gas)**

The user fetches the attestation and submits it to the contract:

```
contract.recordBurnWithAttestation(
  inscriptionId,
  burner,
  deadline,       // OPNet block height
  nonce,
  oraclePublicKey, // 1312-byte ML-DSA-44 public key
  oracleSig        // 2420-byte ML-DSA-44 signature
)
contract.mint(inscriptionId)
```

The contract verifies the ML-DSA-44 signature on-chain and mints the OP721 token to the burner.

### Oracle Pipeline

```
onBlockPreProcess(IBlockData)
    │
    └── BurnWatcher.scanBlock()
            ├── detect output → burnAddress
            ├── extract burner OPNet address from OP_RETURN (6a20 + 32 bytes)
            └── for each input UTXO:
                    GET /output/{txid}:{vout}  [local ord node]
                    → confirm inscription exists on that UTXO
                    → store burn in MongoDB

GET /plugins/ordinals-oracle/attestation/:txid
    │
    └── AttestationSigner.sign(burn, currentBlockHeight)
            ├── generate fresh 32-byte nonce
            ├── deadline = currentBlockHeight + ttlBlocks
            ├── hash = sha256(contractAddr | inscId_len | inscId | burner | deadline | nonce)
            └── sig = ml_dsa44.sign(hash, secretKey)  ← post-quantum, off-chain only
```

---

## Signature Scheme

The oracle uses **ML-DSA-44** (FIPS 204, post-quantum lattice-based signatures):

- Public key: **1312 bytes**
- Secret key: **2560 bytes** (derived deterministically from your 32-byte seed)
- Signature: **2420 bytes**
- Oracle identity: `sha256(publicKey)` — registered in the contract as `_oracleKeyHash`

The contract stores only the 32-byte hash. Users pass the full public key in calldata; the contract hashes it and verifies the match before running `Blockchain.verifyMLDSASignature`.

---

## Setup: Registering the Oracle Key

Before deploying the contract, compute your oracle key hash:

```bash
# 1. Generate a random seed (keep this secret — it's your oracle key)
SEED=$(openssl rand -hex 32)
echo "Seed: $SEED"

# 2. Compute the public key hash to register in the contract
node -e "
import('@btc-vision/post-quantum/ml-dsa.js').then(async ({ ml_dsa44 }) => {
  const { createHash } = await import('crypto');
  const seed = Buffer.from('$SEED', 'hex');
  const { publicKey } = ml_dsa44.keygen(seed);
  const hash = createHash('sha256').update(publicKey).digest('hex');
  console.log('oracleKeyHash (deploy param):', hash);
});
"
```

Pass the resulting `oracleKeyHash` as a deployment parameter to the OrdinalsVault contract (`_oracleKeyHash = sha256(mldsaPublicKey)`). Set `SEED` as `oracleMLDSASeed` in your plugin config.

---

## Requirements

- OPNet node with plugin support
- Local [`ord`](https://github.com/ordinals/ord) node running with `--http`:
  ```bash
  ord --bitcoin-rpc-url http://127.0.0.1:8332 server --http --http-port 80
  ```
- MongoDB (provided by the OPNet node)
- No funded oracle wallet needed — the oracle pays zero gas

---

## Installation

```bash
npm install
npm run build
```

Copy `dist/` and `plugin.json` to your OPNet node's plugin directory.

---

## Configuration

Copy `plugin.config.example.json` to `plugin.config.json`:

```json
{
    "oracle": {
        "burnAddress": "bc1p...",
        "ordNodeUrl": "http://localhost:80",
        "vaultContractAddress": "64hexchars_no_0x_prefix",
        "oracleMLDSASeed": "64hexchars_secret_32bytes_entropy",
        "attestationTtlBlocks": 144
    }
}
```

| Field | Description |
|-------|-------------|
| `burnAddress` | Bitcoin address where inscriptions are sent to burn (P2TR recommended) |
| `ordNodeUrl` | Local `ord` node HTTP URL |
| `vaultContractAddress` | Deployed OrdinalsVault contract address (64-char hex, no `0x`) |
| `oracleMLDSASeed` | 64-char hex seed (32 bytes). Deterministically derives the ML-DSA-44 keypair. **Keep this secret.** |
| `attestationTtlBlocks` | Attestation validity in OPNet blocks (default: 144 ≈ 1 day) |

---

## REST Endpoints

### `GET /plugins/ordinals-oracle/attestation/:txid`

Returns a signed attestation for a confirmed burn transaction.

**Response:**
```json
{
  "txid": "abc...64chars",
  "inscriptionId": "abc...i0",
  "burner": "64hexchars",
  "deadline": 850000,
  "nonce": "64hexchars",
  "oraclePublicKey": "2624hexchars",
  "oracleSig": "4840hexchars"
}
```

Pass all fields directly to `recordBurnWithAttestation()`.

### `GET /plugins/ordinals-oracle/burns`

Lists all detected burns (newest first). Supports `?limit=50&offset=0`.

---

## Plugin Permissions

```json
{
    "blocks": { "preProcess": true },
    "database": { "enabled": true, "collections": ["oracle_burns"] },
    "filesystem": { "configDir": true },
    "addEndpoints": true
}
```

---

## Security

- `oracleMLDSASeed` must be kept secret. It's the root of your oracle's signing authority. Use your node's secure config storage — never commit it.
- Each attestation uses a fresh random nonce (anti-replay). Consumed nonces are tracked on-chain by the contract.
- Burns are stored in MongoDB with a unique index on `burnTxid` — restarts are safe and idempotent.
- On chain reorg, the plugin purges reorged burns from MongoDB so they're re-detected on the canonical chain.

---

## Related

- [ordinals-vault](https://github.com/Lafourkad/ordinals-vault) — The OrdinalsVault OP721 contract
- [ordinals-renderer](https://github.com/Lafourkad/ordinals-renderer) — Plugin to serve inscription content via OPNet nodes
- [OPNet Documentation](https://docs.opnet.org)
