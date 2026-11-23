# Safe transaction decoder

`safe-decode` turns Safe multisig calldata into a readable call tree so signers can review a proposal before signing. It never asks for a wallet key, connects to a wallet, signs, or broadcasts a transaction.

## Install

Node.js 18 or newer is required. Install from the GitHub tag (no npm registry publication):

```sh
npx --yes --package='github:piolpro/safe-tx-decoder#v0.1.0' safe-decode --help
```

Or download the package tarball from the [GitHub releases](https://github.com/piolpro/safe-tx-decoder/releases) and run `npm install -g ./safe-tx-decoder-0.1.0.tgz`. For local builds, use Node.js 22.12+.

## Usage

If installed globally, invoke `safe-decode` directly; otherwise replace it with the pinned `npx` command above (without `--help`).

```sh
# Look up a Safe transaction hash (not the on-chain execution hash).
safe-decode 0xa15d670d17621751bb88f493f8b305c5bde4eeaa7aa4f9875da4d9bd2fad39b0

# Paste an app link; quote it because it contains an ampersand.
safe-decode 'https://app.safe.global/transactions/tx?safe=eth:0x849D52316331967b6fF1198e5E32A0eB168D039d&id=multisig_0x849D52316331967b6fF1198e5E32A0eB168D039d_0xa15d670d17621751bb88f493f8b305c5bde4eeaa7aa4f9875da4d9bd2fad39b0'

# Find a proposal by Safe and nonce; substitute your current pending nonce.
safe-decode --safe 0x849D52316331967b6fF1198e5E32A0eB168D039d --nonce 3000 --chain eth

# Decode raw calldata, with no requests after the CLI is installed.
safe-decode --to 0x0000000000000000000000000000000000001234 --data 0x \
  --value 1000000000000000000 --operation 0 --json
```

- `--chain` accepts `eth` (default), `oeth`, `bnb`, `gno`, `matic`, `base`, `arb1`, `avax`, `sep`, and their chain IDs. Safe app links supply the chain.
- `--operation`: `0` = CALL, `1` = DELEGATECALL. `--value` is in wei, decimal or hex. JSON preserves amounts as strings and includes raw calldata at each node.
- `--safe ... --nonce ...` searches pending proposals; if multiple proposals share the nonce, choose one explicitly by hash.
- Hash, link and nonce lookups use the Safe Transaction Service. Set `SAFE_API_KEY` for authenticated access if anonymous access is denied or rate-limited.
- Online inputs optionally read a token's symbol and decimals from a public chain RPC. Use `--rpc <url>` to override it. Raw mode is offline by default; `--rpc` enables just token metadata, while `--online` also enables signature/ABI lookups.
- Unrecognized calls use Safe Transaction Service decoding where available, then optional Etherscan V2 verified ABIs (`ETHERSCAN_API_KEY`), then OpenChain selector candidates. A selector match is not proof of what a contract does. Unavailable lookups leave the original interpretation intact.

## Real mainnet examples

[Three executed examples and their output](examples/mainnet.md) cover a MultiSendCallOnly batch, a token allowance, and an owner removal. Their raw inputs are archived as [offline test fixtures](test/fixtures/mainnet.json), so the examples can be rendered without access to the Safe API.

## Reading the output

- **HIGH** calls merit direct verification: delegatecall outside recognized MultiSend usage; proxy implementation or admin changes; Safe owner, threshold, module, guard, or fallback-handler changes; unlimited ERC-20/Permit2 allowances; and collection-wide NFT approvals.
- **CAUTION** includes regular allowances, recognized MultiSend delegatecalls (review every child), unknown calldata, and selector ambiguity. ERC-20 and ERC-721 share `approve(address,uint256)` and `transferFrom(address,address,uint256)`; check the target's contract type.
- Nested MultiSend and MultiSendCallOnly payloads are unpacked by operation, target, value, and calldata. Known library labels identify addresses from [Safe deployments](https://github.com/safe-global/safe-deployments) on Ethereum mainnet; they do not verify bytecode. Other addresses with the MultiSend selector are labeled as speculative.

**This is a calldata review, not simulation, an audit, or a green light to sign.** Contracts can interpret calldata differently or have behavior absent from their ABIs. RPC metadata can be wrong. Pending inputs rely on the Safe service and the reported Safe hash is checked against the request, not independently regenerated. The tool does not verify signatures, chain state, balances, gas/refund fields, or the outcome of arbitrary calls and initializer calldata. It handles Permit2 AllowanceTransfer approvals and permits, not the entire Permit2 API. Batches stop at malformed data or review limits (depth 12; 1,000 calls) and report incomplete output. Independently verify what your wallet will sign.

Online lookups disclose the proposal or address/selector being queried to the relevant provider. Avoid online lookups for sensitive unpublished proposals.

## Development

```sh
npm ci
npm test
npm run build
node dist/cli.js --help
```

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
