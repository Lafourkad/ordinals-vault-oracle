# ordinals-vault-oracle

An [OPNet](https://opnet.org) node plugin that bridges Bitcoin Ordinals to OP721 tokens on OPNet.

Watches every Bitcoin block for Ordinal burn transactions, verifies them against a local `ord` node, and calls `recordBurn()` on the deployed [OrdinalsVault](https://github.com/Lafourkad/ordinals-vault) contract.

---

## How It Works

### Burn Transaction Format

To bridge an Ordinal to OPNet, the user sends a Bitcoin transaction with this exact structure:

```
vin[0]:   UTXO holding the inscription
vout[0]:  <burnAddress>                        ← inscription lands here
vout[1]:  OP_RETURN <opnet_address_32_bytes>   ← who receives the OP721 mint
vout[2]:  change (optional)
```

The 32-byte OPNet address in the `OP_RETURN` tells the oracle which OPNet account gets the minted OP721 token.

### Oracle Pipeline

```
onBlockPreProcess(IBlockData)
    │
    ├── BurnWatcher.scanBlock()
    │       ├── detect output → burnAddress
    │       ├── extract burner OPNet address from OP_RETURN
    │       └── for each input UTXO:
    │               query local ord → GET /output/{txid}:{vout}
    │               → returns inscription IDs on that UTXO
    │
    └── ContractCaller.submitBurn()
            ├── getContract<IOrdinalsVaultOracle>(vaultAddress, ABI, provider)
            ├── simulate contract.recordBurn(inscriptionId, burnerAddress)
            └── sign + broadcast with oracle keypair (WIF)
```

Burns are persisted to MongoDB for idempotency — restarts won't resubmit already-recorded burns.

---

## Requirements

- OPNet node with plugin support
- Local [`ord`](https://github.com/ordinals/ord) node running with `--http`:
  ```bash
  ord --bitcoin-rpc-url http://127.0.0.1:8332 server --http --http-port 80
  ```
- Oracle wallet funded with BTC (to pay for `recordBurn` transactions)
- The oracle address must be the OrdinalsVault deployer (or whitelisted as oracle)

---

## Installation

```bash
npm install
npm run build
```

Copy `dist/` and `plugin.json` to your OPNet node's plugin directory.

---

## Configuration

Copy `plugin.config.example.json` to `plugin.config.json` and fill in your values:

```json
{
    "oracle": {
        "vaultContractAddress": "op1q...",
        "burnAddress": "bc1p...",
        "ordNodeUrl": "http://localhost:80",
        "opnetRpcUrl": "https://mainnet.opnet.org/json-rpc",
        "oraclePrivateKeyWIF": "KwDiBf...",
        "maxSatToSpend": 10000,
        "network": "mainnet"
    }
}
```

| Field | Description |
|-------|-------------|
| `vaultContractAddress` | Deployed OrdinalsVault contract address |
| `burnAddress` | Bitcoin address where inscriptions are sent to burn (P2TR recommended) |
| `ordNodeUrl` | Local ord node HTTP URL |
| `opnetRpcUrl` | OPNet JSON-RPC endpoint |
| `oraclePrivateKeyWIF` | Oracle wallet private key (WIF format) — keep this secret |
| `maxSatToSpend` | Max satoshis per `recordBurn` transaction |
| `network` | `mainnet` or `regtest` |

---

## Plugin Permissions

```json
{
    "blocks": { "preProcess": true },
    "database": { "enabled": true, "collections": ["oracle_burns"] },
    "filesystem": { "configDir": true }
}
```

---

## Security

- The oracle private key (`oraclePrivateKeyWIF`) must be kept secret. Use your node's secure config storage — never commit it.
- The oracle address should be a dedicated wallet, not your main wallet.
- Burns are idempotent: each `(burnTxid, inscriptionId)` pair is recorded once.

---

## Related

- [ordinals-vault](https://github.com/Lafourkad/ordinals-vault) — The OrdinalsVault OP721 contract
- [ordinals-renderer](https://github.com/Lafourkad/ordinals-renderer) — Plugin to serve inscription content via OPNet nodes
- [OPNet Documentation](https://docs.opnet.org)
