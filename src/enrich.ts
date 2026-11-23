import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, type Abi, type Hex } from 'viem'
import type { Node } from './decode.js'
import { asRecord, readJson } from './service.js'

const tokenAbi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])

function display(text: string, max = 240) {
  return text.replace(/[^\x20-\x7e]/g, '?').slice(0, max)
}

function valueText(value: unknown) {
  return display(typeof value === 'bigint' ? value.toString() : JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v) ?? '?')
}

function useServiceDecode(node: Node, raw: unknown) {
  if (!raw || !node.selector) return
  const service = asRecord(raw)
  if (!node.decodedBy && typeof service.method === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(service.method)) {
    const params = Array.isArray(service.parameters) ? service.parameters.slice(0, 12) : []
    node.summary = `Call ${service.method}(${params.map(p => {
      const { name, value } = asRecord(p)
      return `${typeof name === 'string' && name ? display(name, 40) + '=' : ''}${valueText(value)}`
    }).join(', ')})`
    node.decodedBy = 'safe-service'
  }
  if (node.children) {
    const parameter = Array.isArray(service.parameters) ? service.parameters[0] : undefined
    const children = parameter && asRecord(parameter).valueDecoded
    if (Array.isArray(children) && children.length === node.children.length) {
      node.children.forEach((child, i) => {
        const info = asRecord(children[i])
        if (typeof info.to === 'string' && info.to.toLowerCase() === child.to.toLowerCase()
          && (typeof info.data === 'string' ? info.data.toLowerCase() : '0x') === child.data) {
          try { useServiceDecode(child, info.dataDecoded) } catch { /* optional metadata */ }
        }
      })
    }
  }
}

async function lookupSignatures(selector: Hex): Promise<string[]> {
  const response = asRecord(await readJson(`https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}`))
  if (response.ok !== true) return []
  const result = asRecord(asRecord(response.result).function)[selector]
  if (!Array.isArray(result)) return []
  return [...new Set(result.flatMap(row =>
    row?.filtered === false && typeof row.name === 'string' ? [display(row.name, 120)] : [],
  ))].slice(0, 5)
}

export async function enrich(
  node: Node,
  opts: { chainId: number; rpc?: string; decoded?: unknown; etherscanKey?: string; lookupSignatures?: boolean },
) {
  try { useServiceDecode(node, opts.decoded) } catch { /* optional metadata */ }
  type Meta = { symbol: string; decimals: number }
  const tokens = new Map<string, Promise<Meta | undefined>>()
  const abis = new Map<string, Promise<Abi | undefined>>()
  const signatures = new Map<Hex, Promise<string[]>>()
  function cached<K, V>(cache: Map<K, Promise<V>>, key: K, fetch: () => Promise<V>, fallback: V) {
    if (cache.size < 24 && !cache.has(key)) cache.set(key, fetch().catch(() => fallback))
    return cache.get(key) ?? Promise.resolve(fallback)
  }
  async function readToken(address: Hex): Promise<Meta | undefined> {
    if (!opts.rpc) return
    const rpc = opts.rpc
    async function read(functionName: 'symbol' | 'decimals') {
      const args = { abi: tokenAbi, functionName } as const
      const response = asRecord(await readJson(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data: encodeFunctionData(args) }, 'latest'] }),
      }))
      if (typeof response.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(response.result)) throw new Error('Invalid RPC result')
      return decodeFunctionResult({ ...args, data: response.result as Hex })
    }
    const [symbol, decimals] = await Promise.all([read('symbol'), read('decimals')])
    if (typeof symbol === 'string' && symbol.length > 0 && symbol.length <= 24 && typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255) {
      return { symbol: display(symbol, 24), decimals }
    }
  }
  async function verifiedAbi(address: Hex): Promise<Abi | undefined> {
    if (!opts.etherscanKey) return
    const params = new URLSearchParams({ chainid: String(opts.chainId), module: 'contract', action: 'getabi', address, apikey: opts.etherscanKey })
    const response = asRecord(await readJson(`https://api.etherscan.io/v2/api?${params}`))
    if (response.status !== '1' || typeof response.result !== 'string') return
    const abi: unknown = JSON.parse(response.result)
    if (Array.isArray(abi)) return abi as Abi
  }
  async function enrichCall(call: Node) {
    if (call.token && opts.rpc && call.operation === 'CALL') {
      const token = call.token
      const meta = await cached(tokens, token.address.toLowerCase(), () => readToken(token.address), undefined)
      if (meta) token.formatted = `${formatUnits(BigInt(token.amount), meta.decimals)} ${meta.symbol}`
    }
    const selector = call.selector
    if (call.decodedBy || !selector) return
    if (opts.etherscanKey) {
      const abi = await cached(abis, call.to.toLowerCase(), () => verifiedAbi(call.to), undefined)
      if (abi) {
        try {
          const { functionName, args } = decodeFunctionData({ abi, data: call.data })
          call.summary = `Call ${display(functionName, 80)}(${args?.slice(0, 12).map(valueText).join(', ') ?? ''})`
          call.decodedBy = 'verified-abi'
          return
        } catch { /* try selector candidates */ }
      }
    }
    if (opts.lookupSignatures) {
      const candidates = await cached(signatures, selector, () => lookupSignatures(selector), [])
      if (candidates.length) {
        call.summary = `Unknown call; possible signatures: ${candidates.join(' | ')}`
        call.decodedBy = 'signature-candidates'
      }
    }
  }
  function* walk(node: Node): Generator<Node> {
    yield node
    for (const child of node.children ?? []) yield* walk(child)
  }
  const work = walk(node)
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (const call of work) await enrichCall(call)
  }))
}
