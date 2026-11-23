import { afterEach, describe, expect, it, vi } from 'vitest'
import { decode, normalizeCall } from '../src/decode.js'
import { enrich } from '../src/enrich.js'
import { fetchSafeTransaction, parseChain, parseLink, parseSafe } from '../src/service.js'
import mainnet from './fixtures/mainnet.json'

const { safeTxHash, safe } = mainnet.approval
const link = `https://app.safe.global/transactions/tx?safe=eth:${safe}&id=multisig_${safe}_${safeTxHash}`

afterEach(() => vi.unstubAllGlobals())

describe('Safe Transaction Service inputs', () => {
  it('parses the Safe app URL and rejects conflicting accounts and other hosts', () => {
    expect(parseLink(link)).toMatchObject({ safe, hash: safeTxHash, chain: { id: 1 } })
    expect(() => parseLink(link.replace(safe, mainnet.ownerChange.safe))).toThrow('do not agree')
    expect(() => parseLink(link.replace('app.safe.global', 'other.example'))).toThrow('Safe app')
  })
  it('normalizes chain slugs and chain IDs', () => {
    expect(parseChain('mainnet')).toEqual(parseChain('1'))
    expect(parseChain('arbitrum').slug).toBe('arb1')
    expect(() => parseChain('not-a-chain')).toThrow('Unsupported chain')
  })
  it('requests the Safe hash, checks echoed identity, and preserves execution status', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(mainnet.approval))
    vi.stubGlobal('fetch', fetch)
    const chain = parseChain()
    const parsed = parseLink(link)
    await expect(fetchSafeTransaction(chain, parsed, 'test-key')).resolves.toMatchObject({ executed: true, hash: safeTxHash })
    expect(fetch).toHaveBeenCalledWith(`https://api.safe.global/tx-service/eth/api/v1/multisig-transactions/${safeTxHash}/`,
      expect.objectContaining({ headers: { Authorization: 'Bearer test-key' }, redirect: 'error' }))
    fetch.mockResolvedValueOnce(Response.json(mainnet.ownerChange))
    await expect(fetchSafeTransaction(chain, parsed)).rejects.toThrow('does not match')
  })
  it('does not silently select between competing proposals at a pending nonce', async () => {
    const nonce = mainnet.approval.nonce
    const query = { safe: parseSafe(safe), nonce }
    const proposal = { ...mainnet.approval, isExecuted: false }
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ results: [proposal] }))
      .mockResolvedValueOnce(Response.json({ results: [proposal, { ...proposal, safeTxHash: mainnet.batch.safeTxHash }] }))
      .mockResolvedValueOnce(Response.json({ results: [] }))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchSafeTransaction(parseChain(), query)).resolves.toMatchObject({ executed: false, nonce })
    expect(fetch.mock.calls[0]?.[0]).toContain(`executed=false&nonce=${nonce}&limit=2`)
    await expect(fetchSafeTransaction(parseChain(), query)).rejects.toThrow('Multiple proposals')
    await expect(fetchSafeTransaction(parseChain(), query)).rejects.toThrow('No pending transaction')
  })
})

describe('optional metadata', () => {
  const unknownCall = () => decode(normalizeCall({ to: safe, data: '0xaa9224cd' }))
  it('uses Safe metadata ahead of external lookup without removing the unknown call warning', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const node = unknownCall()
    await enrich(node, {
      chainId: 1, lookupSignatures: true, etherscanKey: 'test-key',
      decoded: { method: 'withdraw', parameters: [{ name: 'value', value: 15 }] },
    })
    expect(node.summary).toBe('Call withdraw(value=15)')
    expect(node.decodedBy).toBe('safe-service')
    expect(node.risks).toHaveLength(1)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('labels selector matches as candidates rather than an ABI decode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      ok: true, result: { function: { '0xaa9224cd': [{ name: 'withdraw(uint32)', filtered: false }] } },
    })))
    const node = unknownCall()
    await enrich(node, { chainId: 1, lookupSignatures: true })
    expect(node.summary).toBe('Unknown call; possible signatures: withdraw(uint32)')
    expect(node.decodedBy).toBe('signature-candidates')
  })
  it('keeps the offline interpretation if optional networks fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const node = unknownCall()
    await enrich(node, { chainId: 1, lookupSignatures: true, etherscanKey: 'test-key' })
    expect(node).toEqual(unknownCall())
  })
})
