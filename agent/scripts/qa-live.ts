/**
 * QA against a LIVE deployment: every product invariant (CLAUDE.md) is exercised on-chain.
 *
 *   pnpm tsx scripts/qa-live.ts [network]          # read-only: rejections simulated with eth_call
 *   pnpm tsx scripts/qa-live.ts [network] --live   # + guardian pause, paused redeem, emergencyExit
 *
 * Rejections are simulated (no gas) with a block-time override past the rebalance interval, so
 * each case fails for exactly the reason under test. A correctly signed control intent must pass
 * the same simulation, proving the rejections are not false positives. Nothing signed by the
 * agent key here is ever broadcast.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { fromBase58 } from '@amadeus-protocol/sdk';
import { vaultAbi } from '../src/chain/vaultAbi.js';
import { revertName, robinhoodChain } from '../src/chain/vaultClient.js';
import { intentDigest, type RebalanceIntent, type Regime } from '../src/intent/eip712.js';
import { keypairFromSeed64, signDigest } from '../src/amadeus/bls.js';

loadEnv({ path: resolve(import.meta.dirname, '../../.env') });
const network = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'robinhood-testnet';
const LIVE = process.argv.includes('--live');
const d = JSON.parse(readFileSync(resolve(import.meta.dirname, `../../deployments/${network}.json`), 'utf8')) as Record<string, string>;
const RPC = process.env.QA_RPC_URL ?? process.env.RPC_URL!;
const API = process.env.QA_AGENT_API_URL;
const chainId = Number(d.chainId);
const vault = d.vault as Address;

const chain = robinhoodChain({ CHAIN_ID: chainId, RPC_URL: RPC, EXPLORER_URL: 'https://explorer.testnet.chain.robinhood.com' });
const pub = createPublicClient({ chain, transport: http(RPC) });
const relayer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const owner = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
const ownerWallet = createWalletClient({ chain, transport: http(RPC), account: owner });
const agentKey = keypairFromSeed64(fromBase58(process.env.AMADEUS_SEED_B58!)).secretKey;
const strangerKey = keypairFromSeed64(crypto.getRandomValues(new Uint8Array(64))).secretKey;

const safetyAbi = parseAbi([
  'function setPaused(bool paused)',
  'function paused() view returns (bool)',
  'function emergencyExit()',
  'function guardrails() view returns (uint16, uint64, uint16, uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
]);

let failures = 0;
function expect(ok: boolean, message: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

const read = <T>(functionName: string, abi: readonly unknown[] = vaultAbi) =>
  pub.readContract({ address: vault, abi: abi as typeof vaultAbi, functionName: functionName as never }) as Promise<T>;

/** Simulates executeIntent at `time`; returns the revert error name, or 'ok'. */
async function simulate(intent: RebalanceIntent, signature: Hex, time: bigint): Promise<string> {
  try {
    await pub.call({
      account: relayer,
      to: vault,
      data: encodeFunctionData({
        abi: vaultAbi,
        functionName: 'executeIntent',
        args: [intent.nonce, intent.deadline, intent.regime, intent.morphoBps, intent.uniswapBps, intent.volBps, intent.inputsHash, intent.modelVersion, signature],
      }),
      blockOverrides: { time },
      gas: 6_000_000n,
    });
    return 'ok';
  } catch (err) {
    return revertName(err) ?? 'Unknown';
  }
}

const signWith = (key: Uint8Array, intent: RebalanceIntent): Hex => signDigest(intentDigest(chainId, intent), key).uncompressed;

async function intentChecks(): Promise<void> {
  const [nonce, agent, rails] = await Promise.all([
    read<bigint>('nonce'),
    read<readonly [number, number, number, bigint, Hex]>('agentState'),
    read<readonly [number, bigint, number, bigint]>('guardrails', safetyAbi),
  ]);
  const [regime, morphoBps, uniswapBps, lastRebalance] = agent;
  const [maxUniswapBps, minInterval] = rails;
  const latest = await pub.getBlock();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const time = [now, latest.timestamp, lastRebalance + minInterval].reduce((a, b) => (a > b ? a : b)) + 60n;

  const base: RebalanceIntent = {
    vault, nonce, deadline: time + 600n, regime: regime as Regime, morphoBps, uniswapBps, volBps: 0,
    inputsHash: keccak256(toHex('qa-live')), modelVersion: keccak256(toHex('qa')),
  };
  const sign = (i: RebalanceIntent) => signWith(agentKey, i);
  console.log(`      vault ${vault} nonce ${nonce} regime ${regime} (${morphoBps}/${uniswapBps}) maxLP ${maxUniswapBps}`);

  expect((await simulate(base, sign(base), time)) === 'ok', 'control: a correctly signed intent passes every check');

  const forged = (await simulate(base, toHex(crypto.getRandomValues(new Uint8Array(256))), time));
  expect(forged === 'InvalidSignature' || forged === 'Unknown', 'no signature, no movement: random signature bytes are rejected', forged);
  expect((await simulate(base, signWith(strangerKey, base), time)) === 'InvalidSignature', 'only the configured Amadeus key: a valid BLS signature from another key is rejected');

  const tampered = { ...base, uniswapBps: base.uniswapBps === 0 ? 1000 : 0, morphoBps: base.uniswapBps === 0 ? 9000 : 10000 };
  expect((await simulate(tampered, sign(base), time)) === 'InvalidSignature', 'tampering: the agent signature does not cover a modified allocation');

  if (nonce > 0n) {
    const replay = { ...base, nonce: nonce - 1n };
    expect((await simulate(replay, sign(replay), time)) === 'InvalidNonce', 'replay: an already-used nonce is rejected');
  }
  const skip = { ...base, nonce: nonce + 1n };
  expect((await simulate(skip, sign(skip), time)) === 'InvalidNonce', 'ordering: a future nonce is rejected');

  const expired = { ...base, deadline: time - 1n };
  expect((await simulate(expired, sign(expired), time)) === 'IntentExpired', 'deadline: an expired intent is rejected');

  const overCap = { ...base, regime: 0 as Regime, morphoBps: 10000 - (maxUniswapBps + 1000), uniswapBps: maxUniswapBps + 1000 };
  expect((await simulate(overCap, sign(overCap), time)) === 'InvalidAllocation', `guardrail: LP above ${maxUniswapBps / 100}% is rejected`);

  const overFull = { ...base, morphoBps: 6000, uniswapBps: 5000 };
  expect((await simulate(overFull, sign(overFull), time)) === 'InvalidAllocation', 'guardrail: morpho + uniswap above 100% is rejected');

  const riskOffLp = { ...base, regime: 2 as Regime, morphoBps: 9000, uniswapBps: 1000 };
  expect((await simulate(riskOffLp, sign(riskOffLp), time)) === 'InvalidAllocation', 'guardrail: no LP leg in RISK_OFF');

  if (lastRebalance > 0n) {
    const early = lastRebalance + minInterval - 1n;
    const soon = { ...base, deadline: early + 600n };
    expect((await simulate(soon, sign(soon), early)) === 'RebalanceTooSoon', `guardrail: minimum ${minInterval}s between rebalances`);
  }
}

async function apiChecks(api: string): Promise<void> {
  const health = await fetch(`${api}/health`).then((r) => r.json()).catch(() => null);
  expect(health?.ok === true, `agent API reachable at ${api}`);
  const scenario = await fetch(`${api}/scenario`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"scenario":"recession"}' });
  expect(scenario.status === 401, 'demo control requires the bearer token', `HTTP ${scenario.status}`);
  const rpc = (body: string) => fetch(`${api}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const chainIdRes = await rpc('{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}').then((r) => r.json()).catch(() => null);
  expect(chainIdRes?.result === toHex(chainId), 'public RPC proxy serves the right chain', chainIdRes?.result);
  for (const method of ['anvil_setBalance', 'evm_increaseTime', 'debug_traceTransaction']) {
    const r = await rpc(`{"jsonrpc":"2.0","id":1,"method":"${method}","params":[]}`);
    expect(r.status === 403, `RPC proxy blocks ${method}`, `HTTP ${r.status}`);
  }
  const smuggle = await rpc('{"jsonrpc":"2.0","id":1,"method":"eth_chainId","method":"anvil_setBalance"}');
  expect(smuggle.status === 403, 'RPC proxy resists duplicate-key smuggling', `HTTP ${smuggle.status}`);
  const batch = await rpc(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { jsonrpc: '2.0', id: 2, method: 'anvil_mine' }]));
  expect(batch.status === 403, 'RPC proxy blocks a disallowed method hidden in a batch', `HTTP ${batch.status}`);
  const bad = await rpc('{not json');
  expect(bad.status === 400, 'malformed JSON is a 400, not a crash', `HTTP ${bad.status}`);
}

async function ownerTx(functionName: 'setPaused' | 'emergencyExit', args: readonly unknown[] = []): Promise<void> {
  const { request } = await pub.simulateContract({ address: vault, abi: safetyAbi, functionName, args, account: owner } as never);
  const hash = await ownerWallet.writeContract(request as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
}

async function liveChecks(): Promise<void> {
  console.log('      live: guardian controls (real transactions, signed by the owner)');
  await ownerTx('setPaused', [true]);
  expect(await read<boolean>('paused', safetyAbi), 'guardian can pause the vault');

  const nonce = await read<bigint>('nonce');
  const time = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
  const agent = await read<readonly [number, number, number, bigint, Hex]>('agentState');
  const intent: RebalanceIntent = {
    vault, nonce, deadline: time + 600n, regime: agent[0] as Regime, morphoBps: agent[1], uniswapBps: agent[2], volBps: 0,
    inputsHash: keccak256(toHex('qa-paused')), modelVersion: keccak256(toHex('qa')),
  };
  expect((await simulate(intent, signWith(agentKey, intent), time)) === 'Paused', 'paused: even a valid agent intent cannot move funds');

  const held = (await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [owner.address] })) as bigint;
  if (held > 0n) {
    const redeemShares = held / 100n;
    const usdg = d.usdg as Address;
    const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
    const before = await pub.readContract({ address: usdg, abi: erc20, functionName: 'balanceOf', args: [owner.address] });
    const { request } = await pub.simulateContract({ address: vault, abi: vaultAbi, functionName: 'redeem', args: [redeemShares, owner.address, owner.address], account: owner });
    await pub.waitForTransactionReceipt({ hash: await ownerWallet.writeContract(request) });
    const after = await pub.readContract({ address: usdg, abi: erc20, functionName: 'balanceOf', args: [owner.address] });
    expect(after > before, 'exits never depend on the agent: redeem works while paused', `+${Number(after - before) / 1e6} USDG`);
  } else {
    expect(false, 'exits never depend on the agent: no shares held by the owner to redeem');
  }

  await ownerTx('emergencyExit');
  const [idle, morpho, uniswap] = await read<readonly [bigint, bigint, bigint]>('allocation');
  expect(morpho === 0n && uniswap === 0n && idle > 0n, 'emergencyExit brings every position back to idle USDG', `idle $${Number(idle) / 1e6}`);

  await ownerTx('setPaused', [false]);
  expect(!(await read<boolean>('paused', safetyAbi)), 'guardian can resume the vault (the agent re-allocates on its next tick)');
}

console.log(`QA on ${network} (chain ${chainId}) vault ${vault}${LIVE ? ' [live]' : ''}`);
await intentChecks();
if (API) await apiChecks(API.replace(/\/+$/, ''));
if (LIVE) await liveChecks();
console.log(failures === 0 ? 'QA PASSED' : `QA FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
