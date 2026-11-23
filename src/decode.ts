import { decodeFunctionData, formatEther, getAddress, parseAbi, zeroAddress, type Hex } from 'viem'

export type Operation = 0 | 1
export type Call = { to: Hex; data: Hex; value: bigint; operation: Operation }
export type Risk = { level: 'caution' | 'high'; message: string }
export type Node = {
  to: Hex
  data: Hex
  value: string
  operation: 'CALL' | 'DELEGATECALL'
  selector?: Hex
  summary: string
  risks: Risk[]
  decodedBy?: 'built-in' | 'safe-service' | 'verified-abi' | 'signature-candidates'
  children?: Node[]
  token?: { address: Hex; amount: string; label: string; formatted?: string }
}

const abi = parseAbi([
  'function multiSend(bytes)',
  'function approve(address,uint256)',
  'function increaseAllowance(address,uint256)',
  'function decreaseAllowance(address,uint256)',
  'function setApprovalForAll(address,bool)',
  'function approve(address,address,uint160,uint48)',
  'function permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)',
  'function permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)',
  'function transfer(address,uint256)',
  'function transferFrom(address,address,uint256)',
  'function safeTransferFrom(address,address,uint256)',
  'function safeTransferFrom(address,address,uint256,bytes)',
  'function safeTransferFrom(address,address,uint256,uint256,bytes)',
  'function safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
  'function upgradeTo(address)',
  'function upgradeToAndCall(address,bytes)',
  'function upgrade(address,address)',
  'function upgradeAndCall(address,address,bytes)',
  'function changeAdmin(address)',
  'function changeProxyAdmin(address,address)',
  'function changeMasterCopy(address)',
  'function setFallbackHandler(address)',
  'function setGuard(address)',
  'function setModuleGuard(address)',
  'function enableModule(address)',
  'function disableModule(address,address)',
  'function addOwnerWithThreshold(address,uint256)',
  'function removeOwner(address,address,uint256)',
  'function changeThreshold(uint256)',
  'function swapOwner(address,address,address)',
])

const multisends = new Map([
  ['0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761', 'Safe MultiSend v1.3.0'],
  ['0x998739bfdaadde7c933b942a68053933098f9eda', 'Safe MultiSend v1.3.0'],
  ['0x40a2accbd92bca938b02010e17a5b8929b49130d', 'Safe MultiSendCallOnly v1.3.0'],
  ['0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b', 'Safe MultiSendCallOnly v1.3.0'],
  ['0x38869bf66a61cf6bdb996a6ae40d5853fd43b526', 'Safe MultiSend v1.4.1'],
  ['0x9641d764fc13c8b624c04430c7356c1c7c8102e2', 'Safe MultiSendCallOnly v1.4.1'],
])
const permit2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const maxUint256 = (1n << 256n) - 1n
const maxUint160 = (1n << 160n) - 1n
const maxUint48 = 2 ** 48 - 1
const maxDepth = 12
const maxCalls = 1000

export function normalizeCall(raw: {
  to: unknown; data?: unknown; value?: unknown; operation?: unknown
}): Call {
  if (typeof raw.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw.to)) {
    throw new Error('Target must be a 20-byte 0x-prefixed address')
  }
  const data = raw.data ?? '0x'
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) {
    throw new Error('Calldata must be 0x-prefixed hex with complete bytes')
  }
  const operation = String(raw.operation ?? 0)
  if (operation !== '0' && operation !== '1') throw new Error('Operation must be 0 (CALL) or 1 (DELEGATECALL)')
  const value = String(raw.value ?? 0)
  if (!/^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(value) || BigInt(value) > maxUint256) {
    throw new Error('Value must be an unsigned uint256 (wei)')
  }
  return { to: getAddress(raw.to.toLowerCase() as Hex), data: data.toLowerCase() as Hex, operation: operation === '0' ? 0 : 1, value: BigInt(value) }
}

export function decode(call: Call, chainId = 1): Node {
  let calls = 0
  function visit(call: Call, depth: number): Node {
    calls++
    const { to, data, value, operation } = call
    const library = chainId === 1 ? multisends.get(to.toLowerCase()) : undefined
    const node: Node = {
      to, data, value: value.toString(), operation: operation ? 'DELEGATECALL' : 'CALL',
      ...(data.length >= 10 ? { selector: data.slice(0, 10) as Hex } : {}),
      summary: 'Unrecognized calldata', risks: [],
    }
    function flag(level: Risk['level'], message: string) {
      node.risks.push({ level, message })
    }
    function describe(summary: string, level?: Risk['level'], message?: string) {
      node.summary = summary
      if (level && message) flag(level, message)
    }
    function token(amount: bigint, label: string, address = to) {
      node.token = { address, amount: amount.toString(), label }
    }
    function allowance(amount: bigint, max: bigint) {
      return amount === max ? 'UNLIMITED' : `${amount} base units`
    }
    function permitExpiry(expiry: number) {
      return expiry === maxUint48 ? 'maximum expiry' : `expiry ${expiry} (Unix seconds; 0 means current block)`
    }
    if (operation) {
      if (library && node.selector === '0x8d80ff0a') {
        flag('caution', `DELEGATECALL to known mainnet ${library} address; review every child (bytecode not checked)`)
      } else {
        flag('high', 'DELEGATECALL outside recognized MultiSend usage can run target code in the caller’s storage context')
      }
      if (value !== 0n) flag('caution', 'Nonzero value is recorded, but DELEGATECALL does not send that value')
    }
    if (data === '0x') {
      describe(!operation && value ? `Send ${formatEther(value)} native currency` : 'Empty calldata')
      return node
    }

    let decoded: ReturnType<typeof decodeFunctionData<typeof abi>>
    try {
      decoded = decodeFunctionData({ abi, data })
    } catch {
      const known = node.selector === '0x8d80ff0a'
      flag(known ? 'high' : 'caution', known ? 'Could not decode MultiSend payload' : 'Call effects unknown; inspect calldata before signing')
      return node
    }
    node.decodedBy = 'built-in'
    const { functionName, args } = decoded
    switch (functionName) {
      case 'multiSend': {
        node.summary = library ? `${library} batch` : 'MultiSend-shaped batch'
        if (!library) flag('caution', 'Target is not a recognized MultiSend deployment on this chain; children are an interpretation only')
        if (library && !operation && !library.includes('CallOnly')) flag('high', 'This MultiSend library requires DELEGATECALL')
        node.children = []
        if (depth >= maxDepth) {
          flag('high', 'Batch nesting limit reached; review is incomplete')
          break
        }
        const payload = args[0].slice(2)
        for (let offset = 0; offset < payload.length;) {
          if (calls >= maxCalls) {
            flag('high', 'Call count limit reached; review is incomplete')
            break
          }
          if (offset + 170 > payload.length) {
            flag('high', 'Truncated MultiSend entry header; review is incomplete')
            break
          }
          const op = payload.slice(offset, offset + 2)
          const target = `0x${payload.slice(offset + 2, offset + 42)}`
          const amount = `0x${payload.slice(offset + 42, offset + 106)}`
          const length = BigInt(`0x${payload.slice(offset + 106, offset + 170)}`)
          const start = offset + 170
          if (length > BigInt((payload.length - start) / 2)) {
            flag('high', 'Truncated MultiSend entry calldata; review is incomplete')
            break
          }
          offset = start + Number(length) * 2
          if (op !== '00' && op !== '01') {
            flag('high', `Unsupported MultiSend entry operation 0x${op}; review is incomplete`)
            break
          }
          if (op === '01' && library?.includes('CallOnly')) flag('high', 'MultiSendCallOnly rejects DELEGATECALL entries')
          if (target === zeroAddress) flag('caution', 'Zero-address batch target may resolve to the batch executor on some MultiSend versions')
          node.children.push(visit(normalizeCall({ to: target, data: `0x${payload.slice(start, offset)}`, value: amount, operation: op === '00' ? 0 : 1 }), depth + 1))
        }
        break
      }
      case 'approve': {
        if (args.length === 4) {
          const [asset, spender, amount, expiry] = args
          describe(`Permit2-shaped approval: allow ${spender} to spend ${allowance(amount, maxUint160)} of ${asset}; ${permitExpiry(expiry)}`, amount === maxUint160 ? 'high' : 'caution', 'Review spender, token, amount and expiry')
          if (to.toLowerCase() !== permit2) flag('caution', 'Target is not the canonical Permit2 address')
          if (amount !== maxUint160) token(amount, 'Permit2 allowance', asset)
          break
        }
        const [spender, amount] = args
        describe(`Approve ${spender}: ERC-20 allowance ${allowance(amount, maxUint256)} or ERC-721 token ID ${amount}`, amount === maxUint256 ? 'high' : 'caution', 'ERC-20 and ERC-721 approve share a selector; verify contract type and spender')
        if (amount !== maxUint256) token(amount, 'Allowance if ERC-20')
        break
      }
      case 'permit': {
        const [owner, [details, spender, deadline]] = args
        const entries = Array.isArray(details[0]) ? details as readonly (readonly [Hex, bigint, number, number])[] : [details as readonly [Hex, bigint, number, number]]
        describe(`Permit2-shaped permit: submit allowance authorization from ${owner} to ${spender}; signature deadline ${deadline} (Unix seconds)`, 'high', 'Review the signed permit, spender, token allowances and expiries')
        if (to.toLowerCase() !== permit2) flag('caution', 'Target is not the canonical Permit2 address')
        for (const [asset, amount, expiry] of entries) flag(amount === maxUint160 ? 'high' : 'caution', `Allowance for ${asset}: ${allowance(amount, maxUint160)}; ${permitExpiry(expiry)}`)
        break
      }
      case 'increaseAllowance':
        describe(`Increase ${args[0]}’s allowance by ${args[1] === maxUint256 ? 'the maximum uint256 amount' : `${args[1]} base units`}`, args[1] === maxUint256 ? 'high' : 'caution', 'Review the spender and allowance increase')
        if (args[1] !== maxUint256) token(args[1], 'Allowance increase')
        break
      case 'decreaseAllowance':
        describe(`Decrease ${args[0]}’s allowance by ${args[1]} base units`)
        token(args[1], 'Allowance decrease')
        break
      case 'setApprovalForAll':
        describe(args[1] ? `Grant ${args[0]} operator approval for ALL tokens in this NFT collection` : `Revoke collection-wide operator approval for ${args[0]}`, args[1] ? 'high' : undefined, 'Operator can transfer any of the owner’s tokens in this collection')
        break
      case 'transfer':
        describe(`Transfer ${args[1]} base units to ${args[0]}`)
        token(args[1], 'Transfer amount')
        break
      case 'transferFrom':
        describe(`Transfer from ${args[0]} to ${args[1]}: ${args[2]} base units (ERC-20) or token ID ${args[2]} (ERC-721)`)
        token(args[2], 'Transfer amount if ERC-20')
        break
      case 'safeTransferFrom':
        describe(`Safe transfer token #${args[2]} from ${args[0]} to ${args[1]}${args.length === 5 ? ` (quantity ${args[3]})` : ''}`)
        break
      case 'safeBatchTransferFrom':
        describe(`Safe batch transfer from ${args[0]} to ${args[1]}; token IDs [${args[2].join(', ')}], quantities [${args[3].join(', ')}]`)
        break
      case 'upgradeTo':
      case 'upgradeToAndCall':
      case 'upgrade':
      case 'upgradeAndCall': {
        const [proxy, implementation, init] = functionName === 'upgradeTo' || functionName === 'upgradeToAndCall'
          ? [to, args[0], args[1]]
          : [args[0], args[1], args[2]]
        describe(`Upgrade proxy ${proxy} to implementation ${implementation}${init && init !== '0x' ? `; run initializer calldata ${init}` : ''}`, 'high', 'An upgrade can replace the proxy’s entire logic; review the implementation and any initializer')
        break
      }
      case 'changeAdmin':
      case 'changeProxyAdmin':
        describe(`Change proxy ${args.length === 2 ? args[0] : to} admin to ${args.at(-1)}`, 'high', 'Transfers control over proxy upgrades')
        break
      case 'changeMasterCopy':
        describe(`Change Safe singleton implementation to ${args[0]}`, 'high', 'Replaces Safe logic')
        break
      case 'setFallbackHandler':
      case 'setGuard':
      case 'setModuleGuard': {
        const role = { setFallbackHandler: 'fallback handler', setGuard: 'guard', setModuleGuard: 'module guard' }[functionName]
        describe(args[0] === zeroAddress ? `Remove the Safe ${role}` : `Set the Safe ${role} to ${args[0]}`, 'high', 'Changes Safe handling or enforcement')
        break
      }
      case 'enableModule':
        describe(`Enable Safe module ${args[0]}`, 'high', 'Enabled modules can execute transactions without normal owner approvals')
        break
      case 'disableModule':
        describe(`Disable Safe module ${args[1]}`, 'caution', 'Changes Safe module access')
        break
      case 'addOwnerWithThreshold':
        describe(`Add Safe owner ${args[0]} and set threshold to ${args[1]}`, 'high', 'Changes who can authorize transactions')
        break
      case 'removeOwner':
        describe(`Remove Safe owner ${args[1]} and set threshold to ${args[2]}`, 'high', 'Changes who can authorize transactions')
        break
      case 'swapOwner':
        describe(`Replace Safe owner ${args[1]} with ${args[2]}`, 'high', 'Changes who can authorize transactions')
        break
      case 'changeThreshold':
        describe(`Set the Safe signature threshold to ${args[0]}`, 'high', 'Changes how many owners must authorize transactions')
        break
    }
    return node
  }
  return visit(call, 0)
}

export function render(node: Node, native = 'ETH', depth = 0): string {
  const indent = '  '.repeat(depth)
  const value = node.value === '0' ? '' : ` | Value field: ${formatEther(BigInt(node.value))} ${native} (${node.value} wei)`
  const summary = node.data === '0x' && node.operation === 'CALL' && node.value !== '0'
    ? `Send ${formatEther(BigInt(node.value))} ${native}`
    : node.summary
  const source = node.decodedBy && node.decodedBy !== 'built-in' ? ` [${node.decodedBy}]` : ''
  return [
    `${indent}${node.operation} ${node.to}${value}`,
    `${indent}  ${summary}${source}${node.selector ? ` (${node.selector})` : ''}`,
    ...(node.token?.formatted ? [`${indent}  ${node.token.label}: ${node.token.formatted} (RPC metadata)`] : []),
    ...node.risks.map(({ level, message }) => `${indent}  [${level.toUpperCase()}] ${message}`),
    ...(node.children ?? []).map(child => render(child, native, depth + 1)),
  ].join('\n')
}
