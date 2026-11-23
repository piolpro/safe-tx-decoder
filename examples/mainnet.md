# Mainnet examples

These Ethereum transactions have already executed. The output below comes from decoding the raw `to`, `data`, `value`, and `operation` fields in [the fixtures](../test/fixtures/mainnet.json), without remote metadata.

## MultiSendCallOnly batch

Safe hash: [`0xa15d670d17621751bb88f493f8b305c5bde4eeaa7aa4f9875da4d9bd2fad39b0`](https://api.safe.global/tx-service/eth/api/v1/multisig-transactions/0xa15d670d17621751bb88f493f8b305c5bde4eeaa7aa4f9875da4d9bd2fad39b0/) · [Execution on Etherscan](https://etherscan.io/tx/0xcf5ce1b87453dabdeed8921c6ad5088d9cf3424b0cae9588821558d58f670d42)

```text
DELEGATECALL 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D
  Safe MultiSendCallOnly v1.3.0 batch (0x8d80ff0a)
  [CAUTION] DELEGATECALL to known mainnet Safe MultiSendCallOnly v1.3.0 address; review every child (bytecode not checked)
  CALL 0x0a7CB434f96f65972D46A5c1A64a9654dC9959b2
    Unrecognized calldata (0xaa9224cd)
    [CAUTION] Call effects unknown; inspect calldata before signing
  CALL 0x5aFE3855358E112B5647B952709E6165e1c1eEEe
    Transfer 39000000000000000000000000 base units to 0x458cD345B4C05e8DF39d0A07220feb4Ec19F5e6f (0xa9059cbb)
```

## Token approval

Safe hash: [`0x765dc1a592e652b4ade56ebbffab89fe9656f833201e05ed66925917cf0bbcbc`](https://api.safe.global/tx-service/eth/api/v1/multisig-transactions/0x765dc1a592e652b4ade56ebbffab89fe9656f833201e05ed66925917cf0bbcbc/) · [Execution on Etherscan](https://etherscan.io/tx/0x37fee0dab331ffe525e6e512b1706e898d76cc3dfabdc4bd36647cafa019a2fd)

```text
CALL 0xF5581dFeFD8Fb0e4aeC526bE659CFaB1f8c781dA
  Approve 0x88ad09518695c6c3712AC10a214bE5109a655671: ERC-20 allowance 5000000000000000000000000 base units or ERC-721 token ID 5000000000000000000000000 (0x095ea7b3)
  [CAUTION] ERC-20 and ERC-721 approve share a selector; verify contract type and spender
```

## Safe owner removal

Safe hash: [`0xdb96abf97c7f8187f57c9da5ffc2e2cd437b6040989239a694c742cfdb0ec247`](https://api.safe.global/tx-service/eth/api/v1/multisig-transactions/0xdb96abf97c7f8187f57c9da5ffc2e2cd437b6040989239a694c742cfdb0ec247/) · [Execution on Etherscan](https://etherscan.io/tx/0x62e69929856083fb847caa54f647ebc7095a0f0dbdbfaea0530b55f47ba4fc37)

```text
CALL 0x1Db92e2EeBC8E0c075a02BeA49a2935BcD2dFCF4
  Remove Safe owner 0x3dd4B4dbe6aEe6F49A65F0C1Ac508DeFF761C195 and set threshold to 3 (0xf8dc5dd9)
  [HIGH] Changes who can authorize transactions
```

After building, reproduce all three outputs from the repository root (requires `jq`):

```sh
for name in batch approval ownerChange; do
  node dist/cli.js \
    --to "$(jq -r --arg name "$name" '.[$name].to' test/fixtures/mainnet.json)" \
    --data "$(jq -r --arg name "$name" '.[$name].data' test/fixtures/mainnet.json)" \
    --value "$(jq -r --arg name "$name" '.[$name].value' test/fixtures/mainnet.json)" \
    --operation "$(jq -r --arg name "$name" '.[$name].operation' test/fixtures/mainnet.json)"
done
```
