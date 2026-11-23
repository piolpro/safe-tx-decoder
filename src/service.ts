import { getAddress, type Hex } from 'viem'
import { normalizeCall } from './decode.js'

type Chain = { id: number; slug: string; native: string; rpc: string }
const chains: Chain[] = [
  { id: 1, slug: 'eth', native: 'ETH', rpc: 'https://ethereum-rpc.publicnode.com' },
  { id: 10, slug: 'oeth', native: 'ETH', rpc: 'https://optimism-rpc.publicnode.com' },
  { id: 56, slug: 'bnb', native: 'BNB', rpc: 'https://bsc-rpc.publicnode.com' },
  { id: 100, slug: 'gno', native: 'xDAI', rpc: 'https://gnosis-rpc.publicnode.com' },
  { id: 137, slug: 'matic', native: 'POL', rpc: 'https://polygon-bor-rpc.publicnode.com' },
  { id: 8453, slug: 'base', native: 'ETH', rpc: 'https://base-rpc.publicnode.com' },
  { id: 42161, slug: 'arb1', native: 'ETH', rpc: 'https://arbitrum-one-rpc.publicnode.com' },
  { id: 43114, slug: 'avax', native: 'AVAX', rpc: 'https://avalanche-c-chain-rpc.publicnode.com' },
  { id: 11155111, slug: 'sep', native: 'ETH', rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
]
const aliases: Record<string, string> = {
  mainnet: 'eth', ethereum: 'eth', optimism: 'oeth', bsc: 'bnb', gnosis: 'gno',
  polygon: 'matic', arbitrum: 'arb1', avalanche: 'avax', sepolia: 'sep',
}
const address = /^0x[0-9a-fA-F]{40}$/
const hash = /^0x[0-9a-fA-F]{64}$/

export function parseChain(input = 'eth'): Chain {
  const key = input.toLowerCase()
  const chain = chains.find(c => c.slug === key || c.slug === aliases[key] || String(c.id) === key)
  if (!chain) throw new Error(`Unsupported chain; choose ${chains.map(c => c.slug).join(', ')} or their chain IDs`)
  return chain
}

export function parseSafe(input: unknown): Hex {
  if (typeof input !== 'string' || !address.test(input)) throw new Error('Expected a 20-byte Safe address')
  return getAddress(input.toLowerCase() as Hex)
}

export function parseHash(input: unknown): Hex {
  if (typeof input !== 'string' || !hash.test(input)) throw new Error('Expected a 32-byte Safe transaction hash')
  return input.toLowerCase() as Hex
}

export function parseLink(input: string) {
  const url = new URL(input)
  if (url.origin !== 'https://app.safe.global' || url.pathname !== '/transactions/tx' || url.username || url.password) {
    throw new Error('Expected a Safe app multisig transaction URL')
  }
  const safeParts = url.searchParams.get('safe')?.split(':')
  const idParts = url.searchParams.get('id')?.split('_')
  if (safeParts?.length !== 2 || idParts?.length !== 3 || idParts[0] !== 'multisig') {
    throw new Error('Safe URL must have safe=<chain>:<address> and id=multisig_<address>_<safeTxHash>')
  }
  const safe = parseSafe(safeParts[1])
  if (safe !== parseSafe(idParts[1])) throw new Error('Safe addresses in the URL do not agree')
  return { safe, hash: parseHash(idParts[2]), chain: parseChain(safeParts[0]) }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}

export async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000), redirect: 'error' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

export function fromService(raw: unknown) {
  const tx = asRecord(raw)
  if (typeof tx.value !== 'string' || !Number.isSafeInteger(tx.nonce) || typeof tx.nonce !== 'number' || tx.nonce < 0
    || (tx.operation !== 0 && tx.operation !== 1) || typeof tx.isExecuted !== 'boolean' || !Object.hasOwn(tx, 'data')) {
    throw new Error('Safe Transaction Service returned invalid transaction fields')
  }
  return {
    call: normalizeCall({ to: tx.to, data: tx.data, value: tx.value, operation: tx.operation }),
    safe: parseSafe(tx.safe), hash: parseHash(tx.safeTxHash),
    nonce: tx.nonce, executed: tx.isExecuted, decoded: tx.dataDecoded,
  }
}

export async function fetchSafeTransaction(
  chain: Chain, lookup: { hash: Hex; safe?: Hex } | { safe: Hex; nonce: number },
  apiKey = process.env.SAFE_API_KEY,
) {
  const endpoint = `https://api.safe.global/tx-service/${chain.slug}/api/v1`
  const init = apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined
  const read = async (path: string) => {
    try {
      return await readJson(endpoint + path, init)
    } catch (error) {
      const status = error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : 'network or response error'
      const hint = ['HTTP 401', 'HTTP 403', 'HTTP 429'].includes(status) ? '; try SAFE_API_KEY or use raw input' : ''
      throw new Error(`Safe Transaction Service (${chain.slug}): ${status}${hint}`)
    }
  }
  if ('hash' in lookup) {
    const tx = fromService(await read(`/multisig-transactions/${lookup.hash}/`))
    if (tx.hash !== lookup.hash || (lookup.safe && lookup.safe !== tx.safe)) {
      throw new Error('Returned transaction does not match the requested Safe/hash')
    }
    return tx
  }
  const result = asRecord(await read(`/safes/${lookup.safe}/multisig-transactions/?executed=false&nonce=${lookup.nonce}&limit=2`))
  if (!Array.isArray(result.results)) throw new Error('Safe Transaction Service returned an invalid result list')
  const candidates = result.results.map(fromService)
  if (candidates.some(tx => tx.safe !== lookup.safe || tx.nonce !== lookup.nonce || tx.executed)) {
    throw new Error('Returned transactions do not match the requested pending Safe/nonce')
  }
  if (candidates.length > 1 || result.next) {
    const hashes = candidates.map(tx => tx.hash).join(', ')
    throw new Error(`Multiple proposals share that nonce; look up a specific Safe transaction hash: ${hashes}`)
  }
  if (!candidates[0]) throw new Error('No pending transaction found for that Safe/nonce')
  return candidates[0]
}
