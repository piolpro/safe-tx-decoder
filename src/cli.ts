#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { decode, normalizeCall, render } from './decode.js'
import { enrich } from './enrich.js'
import { fetchSafeTransaction, parseChain, parseHash, parseLink, parseSafe } from './service.js'

const help = `safe-decode — read-only Safe transaction review

Usage:
  safe-decode <safeTxHash | Safe app transaction URL> [--chain eth]
  safe-decode --safe <address> --nonce <n> [--chain eth]
  safe-decode --to <address> [--data 0x] [--value 0] [--operation 0]

Options:
  --chain <slug|id>   Default: eth (or the chain in a Safe app link)
  --data <hex>        Calldata (raw mode)
  --value <wei>       Native value field (raw mode; decimal or hex)
  --operation <0|1>   CALL (0) or DELEGATECALL (1), raw mode only
  --online            Enable metadata lookups in raw mode (normally offline)
  --rpc <url>         Override token metadata RPC; enables RPC in raw mode
  --json              Emit structured JSON instead of text
  --help              Show this help

Environment: SAFE_API_KEY (Safe Transaction Service), ETHERSCAN_API_KEY (optional ABI lookup).
No keys to a wallet are needed. This does not sign, broadcast, or simulate transactions.`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      chain: { type: 'string' }, safe: { type: 'string' }, nonce: { type: 'string' },
      to: { type: 'string' }, data: { type: 'string' }, value: { type: 'string' },
      operation: { type: 'string' }, rpc: { type: 'string' }, online: { type: 'boolean' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(help)
    return
  }
  if (positionals.length > 1) throw new Error('Provide one Safe transaction hash or URL')
  const positional = positionals[0]
  const raw = [values.to, values.data, values.value, values.operation].some(v => v !== undefined)
  const byNonce = values.safe !== undefined || values.nonce !== undefined
  if (Number(raw) + Number(byNonce) + Number(positional !== undefined) !== 1) {
    throw new Error('Choose exactly one input: hash/URL, Safe + nonce, or raw target/calldata')
  }
  const link = positional && /^https?:/i.test(positional) ? parseLink(positional) : undefined
  const chain = values.chain === undefined && link ? link.chain : parseChain(values.chain)
  if (link && link.chain.id !== chain.id) throw new Error('--chain conflicts with the Safe app link')
  if (values.rpc !== undefined) {
    let rpc: URL | undefined
    try { rpc = new URL(values.rpc) } catch { /* error below */ }
    if (!rpc || !['https:', 'http:'].includes(rpc.protocol) || rpc.username || rpc.password) {
      throw new Error('--rpc must be an HTTP(S) URL without embedded credentials')
    }
  }
  let tx: Awaited<ReturnType<typeof fetchSafeTransaction>> | undefined
  if (link) tx = await fetchSafeTransaction(chain, link)
  else if (positional !== undefined) tx = await fetchSafeTransaction(chain, { hash: parseHash(positional) })
  else if (byNonce) {
    const safe = parseSafe(values.safe)
    if (values.nonce === undefined || !/^\d+$/.test(values.nonce) || !Number.isSafeInteger(Number(values.nonce))) {
      throw new Error('--nonce must be a nonnegative safe integer')
    }
    tx = await fetchSafeTransaction(chain, { safe, nonce: Number(values.nonce) })
  }
  const call = tx?.call ?? normalizeCall({ to: values.to, data: values.data, value: values.value, operation: values.operation })
  const result = decode(call, chain.id)
  const lookup = !raw || values.online
  if (lookup || values.rpc) {
    await enrich(result, {
      chainId: chain.id, decoded: tx?.decoded, rpc: values.rpc ?? (lookup ? chain.rpc : undefined),
      etherscanKey: lookup ? process.env.ETHERSCAN_API_KEY : undefined, lookupSignatures: lookup,
    })
  }
  const source = tx ? { safe: tx.safe, safeTxHash: tx.hash, nonce: tx.nonce, executed: tx.executed } : undefined
  if (values.json) console.log(JSON.stringify({ chain: chain.slug, chainId: chain.id, source, transaction: result }, null, 2))
  else {
    if (source) console.log(`Safe ${source.safe} | Chain ${chain.slug} (${chain.id}) | Nonce ${source.nonce} | ${source.executed ? 'EXECUTED' : 'PENDING'}\nSafe transaction hash: ${source.safeTxHash}\n`)
    console.log(render(result, chain.native))
    console.log('\nCalldata interpretation only; not a simulation or a recommendation to sign.')
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message.replace(/[^\x20-\x7e]/g, '?') : 'Unexpected error'
  console.error(`safe-decode: ${message}\nRun safe-decode --help for usage.`)
  process.exitCode = 1
})
