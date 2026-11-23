import { describe, expect, it } from 'vitest'
import { concatHex, encodeFunctionData, encodePacked, maxUint256, parseAbi, type Hex } from 'viem'
import { decode, normalizeCall, render } from '../src/decode.js'
import { fromService } from '../src/service.js'
import mainnet from './fixtures/mainnet.json'

const multi = '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761'
const callOnly = '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D'
const target = '0x0000000000000000000000000000000000001234'
const receiver = '0x0000000000000000000000000000000000004321'
const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const abi = parseAbi([
  'function multiSend(bytes)',
  'function approve(address,uint256)',
  'function approve(address,address,uint160,uint48)',
  'function permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)',
  'function permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)',
  'function upgradeToAndCall(address,bytes)',
  'function upgradeAndCall(address,address,bytes)',
  'function changeProxyAdmin(address,address)',
  'function setApprovalForAll(address,bool)',
])
const bundle = (payload: Hex) => encodeFunctionData({ abi, functionName: 'multiSend', args: [payload] })
const pack = (operation: number, to: Hex, data: Hex, value = 0n) =>
  concatHex([encodePacked(['uint8', 'address', 'uint256', 'uint256'], [operation, to, value, BigInt((data.length - 2) / 2)]), data])
const run = (to: Hex, data: Hex, operation = 0, chain = 1) => decode(normalizeCall({ to, data, operation }), chain)

describe('executed mainnet Safe transactions', () => {
  it('unpacks a real MultiSendCallOnly batch and recognizes the token transfer', () => {
    const tx = fromService(mainnet.batch)
    const tree = decode(tx.call)
    expect(tree.summary).toBe('Safe MultiSendCallOnly v1.3.0 batch')
    expect(tree.operation).toBe('DELEGATECALL')
    expect(tree.risks[0]?.message).toContain('known mainnet')
    expect(tree.children).toHaveLength(2)
    expect(tree.children?.[0]?.summary).toBe('Unrecognized calldata')
    expect(tree.children?.[1]?.summary).toBe('Transfer 39000000000000000000000000 base units to 0x458cD345B4C05e8DF39d0A07220feb4Ec19F5e6f')
  })
  it('shows the spender and raw amount for a real approval', () => {
    const tree = decode(fromService(mainnet.approval).call)
    expect(tree.summary).toContain('Approve 0x88ad09518695c6c3712AC10a214bE5109a655671')
    expect(tree.summary).toContain('5000000000000000000000000 base units')
  })
  it('flags an executed Safe owner removal and reports its threshold', () => {
    const tree = decode(fromService(mainnet.ownerChange).call)
    expect(tree.summary).toContain('Remove Safe owner')
    expect(tree.summary).toContain('threshold to 3')
    expect(tree.risks[0]?.level).toBe('high')
  })
})

describe('offline decoding', () => {
  it('recurses into a nested delegatecall batch without losing an adjacent ETH payment', () => {
    const approval = encodeFunctionData({ abi, functionName: 'approve', args: [receiver, maxUint256] })
    const child = bundle(pack(0, target, approval))
    const tree = run(multi, bundle(concatHex([pack(1, callOnly, child), pack(0, receiver, '0x', 2n * 10n ** 18n)])), 1)
    expect(tree.children?.[0]?.children?.[0]?.summary).toContain('UNLIMITED')
    expect(tree.children?.[0]?.children?.[0]?.risks[0]?.level).toBe('high')
    expect(render(tree)).toContain('Send 2 ETH')
    expect(tree.children?.[1]?.value).toBe('2000000000000000000')
  })
  it('flags an unrecognized delegatecall even with a MultiSend selector, including on another chain', () => {
    expect(run(target, bundle('0x'), 1).risks[0]?.level).toBe('high')
    expect(run(multi, bundle('0x'), 1, 137).summary).toBe('MultiSend-shaped batch')
  })
  it('checks operation, header and length fields before decoding a batch child', () => {
    const malformed = [
      ['0x01', 'Truncated MultiSend entry header'],
      [`0x${pack(0, target, '0x1234').slice(2, -2)}`, 'Truncated MultiSend entry calldata'],
      [pack(2, target, '0x'), 'Unsupported MultiSend entry operation'],
    ] as const
    for (const [data, message] of malformed) {
      const tree = run(multi, bundle(data), 1)
      expect(tree.children).toHaveLength(0)
      expect(tree.risks).toContainEqual({ level: 'high', message: expect.stringContaining(message) })
    }
    expect(render(run(callOnly, bundle(pack(1, target, '0x')), 1))).toContain('MultiSendCallOnly rejects DELEGATECALL entries')
  })
  it('marks deeply nested batches as incomplete', () => {
    let batch = bundle('0x')
    for (let i = 0; i < 15; i++) batch = bundle(pack(1, multi, batch))
    expect(render(run(multi, batch, 1))).toContain('Batch nesting limit reached')
  })
  it('renders proxy upgrades and admin changes as high risk', () => {
    const upgrade = encodeFunctionData({ abi, functionName: 'upgradeToAndCall', args: [receiver, '0xdeadbeef'] })
    const viaAdmin = encodeFunctionData({ abi, functionName: 'upgradeAndCall', args: [target, receiver, '0xdeadbeef'] })
    const admin = encodeFunctionData({ abi, functionName: 'changeProxyAdmin', args: [target, receiver] })
    expect(run(target, upgrade).summary).toBe(`Upgrade proxy ${target} to implementation ${receiver}; run initializer calldata 0xdeadbeef`)
    expect(run(permit2, viaAdmin).summary).toBe(run(target, upgrade).summary)
    expect(run(target, upgrade).risks[0]?.level).toBe('high')
    expect(run(permit2, admin).summary).toBe(`Change proxy ${target} admin to ${receiver}`)
  })
  it('distinguishes granting NFT operator approval from revoking it', () => {
    const data = (enabled: boolean) => encodeFunctionData({ abi, functionName: 'setApprovalForAll', args: [receiver, enabled] })
    expect(run(target, data(true)).risks[0]?.level).toBe('high')
    expect(run(target, data(false)).summary).toContain('Revoke')
    expect(run(target, data(false)).risks).toHaveLength(0)
  })
  it('decodes Permit2 approval and single and batch allowance permits', () => {
    const max160 = (1n << 160n) - 1n
    const approval = encodeFunctionData({ abi, functionName: 'approve', args: [target, receiver, max160, 0] })
    expect(run(permit2, approval).summary).toContain('UNLIMITED')
    const details = [target, max160, 100, 0] as const
    for (const input of [details, [details]] as const) {
      const permit = encodeFunctionData({ abi, functionName: 'permit', args: [target, [input, receiver, 150n], '0x'] })
      const tree = run(permit2, permit)
      expect(tree.summary).toContain('signature deadline 150')
      expect(tree.risks[1]?.message).toContain('UNLIMITED')
    }
  })
  it('validates raw calldata, wei and operation rather than assuming defaults on invalid input', () => {
    expect(() => normalizeCall({ to: target, data: '0xf' })).toThrow('complete bytes')
    expect(() => normalizeCall({ to: target, value: '-1' })).toThrow('uint256')
    expect(() => normalizeCall({ to: target, operation: '2' })).toThrow('Operation')
    expect(() => normalizeCall({ to: '0x0' })).toThrow('20-byte')
  })
})
