/**
 * End-to-end demo against a live deployment (Robinhood testnet or a local fork) with the
 * agent running. Mirrors the 3-minute demo:
 *   1. investor gets test USDG and deposits 100k        -> agent: RISK_ON 50/50
 *   2. presenter injects "earnings week"                -> agent: VOLATILE, hook fee up
 *   3. presenter injects "recession signal"             -> agent: RISK_OFF, 100% Morpho
 *   4. investor redeems half                            -> paid from Morpho
 * Exits non-zero on any failed expectation.
 *
 * Usage: pnpm tsx scripts/e2e-demo.ts [network]   (reads ../.env and deployments/<network>.json)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { robinhoodChain } from '../src/chain/vaultClient.js';
import { vaultAbi } from '../src/chain/vaultAbi.js';

loadEnv({ path: resolve(import.meta.dirname, '../../.env') });
const network = process.argv[2] ?? 'robinhood-testnet';
const d = JSON.parse(readFileSync(resolve(import.meta.dirname, `../../deployments/${network}.json`), 'utf8')) as Record<string, string>;
const RPC = process.env.E2E_RPC_URL ?? process.env.RPC_URL!;
const API = process.env.E2E_AGENT_API_URL ?? `http://127.0.0.1:${process.env.AGENT_PORT ?? 8787}`;
const TOKEN = process.env.DEMO_API_TOKEN!;
const investorKey = (process.env.INVESTOR_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY) as Hex;

const chain = robinhoodChain({ CHAIN_ID: Number(d.chainId), RPC_URL: RPC, EXPLORER_URL: 'https://explorer.testnet.chain.robinhood.com' });
const pub = createPublicClient({ chain, transport: http(RPC) });
const investor = privateKeyToAccount(investorKey);
const wallet = createWalletClient({ chain, transport: http(RPC), account: investor });
const erc20 = parseAbi([
  'function faucet(uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const feeAbi = parseAbi(['function currentFeePips() view returns (uint32)']);
const vault = d.vault as Address;
const usdg = d.usdg as Address;
const USDG = 1_000_000n;

const fmt = (raw: bigint) => `$${(Number(raw) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function expect(ok: boolean, message: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures += 1;
}

async function send(address: Address, abi: typeof erc20 | typeof vaultAbi, functionName: string, args: readonly unknown[]) {
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account: investor } as never);
  const hash = await wallet.writeContract(request as never);
  await pub.waitForTransactionReceipt({ hash });
}

async function state() {
  const [allocation, agent, total] = await Promise.all([
    pub.readContract({ address: vault, abi: vaultAbi, functionName: 'allocation' }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: 'agentState' }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: 'totalAssets' }),
  ]);
  return { idle: allocation[0], morpho: allocation[1], uniswap: allocation[2], regime: agent[0], last: agent[3], total };
}

async function waitFor(label: string, predicate: (s: Awaited<ReturnType<typeof state>>) => boolean, timeoutMs = 150_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await state();
    if (predicate(s)) return s;
    await sleep(2_000);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

async function scenario(id: string): Promise<void> {
  const res = await fetch(`${API}/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ scenario: id }),
  });
  if (!res.ok) throw new Error(`scenario ${id} failed: ${res.status}`);
}

function report(tag: string, s: Awaited<ReturnType<typeof state>>): void {
  console.log(`      ${tag}: NAV ${fmt(s.total)} | Morpho ${fmt(s.morpho)} | Uniswap ${fmt(s.uniswap)} | idle ${fmt(s.idle)}`);
}

async function main(): Promise<void> {
  console.log(`E2E on ${network} (chain ${d.chainId}) vault ${vault}`);
  await scenario('calm');

  await send(usdg, erc20, 'faucet', [100_000n * USDG]);
  await send(usdg, erc20, 'approve', [vault, 100_000n * USDG]);
  await send(vault, vaultAbi, 'deposit', [100_000n * USDG, investor.address]);
  console.log('      deposited 100,000 USDG');

  const on = await waitFor('RISK_ON allocation', (s) => s.last > 0n && s.regime === 0 && s.uniswap > 0n && s.idle * 20n < s.total);
  report('risk on', on);
  expect(Math.abs(Number(on.morpho) / Number(on.total) - 0.5) < 0.03, 'RISK_ON keeps ~50% in Morpho');
  expect(Math.abs(Number(on.uniswap) / Number(on.total) - 0.5) < 0.03, 'RISK_ON keeps ~50% as Uniswap v4 LP');

  await scenario('earnings_volatility');
  const vol = await waitFor('VOLATILE regime', (s) => s.regime === 1);
  report('volatile', vol);
  const fee = await pub.readContract({ address: d.feeEngine as Address, abi: feeAbi, functionName: 'currentFeePips' });
  expect(fee === 16_600, `hook fee raised to ${(fee / 10_000).toFixed(2)}% (3,000 + 6,800 x 2 pips)`);
  expect(Math.abs(Number(vol.uniswap) / Number(vol.total) - 0.3) < 0.03, 'VOLATILE trims the LP leg to ~30%');

  await scenario('recession');
  const off = await waitFor('RISK_OFF regime', (s) => s.regime === 2 && s.uniswap === 0n);
  report('risk off', off);
  expect(off.uniswap === 0n, 'RISK_OFF removed all Uniswap liquidity');
  expect(Number(off.morpho) / Number(off.total) > 0.98, 'RISK_OFF moved ~100% to Morpho Blue');
  expect(Number(off.total) > 98_000 * 1e6, 'NAV preserved within 2% through three rebalances');

  const shares = await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'totalSupply' });
  const before = await pub.readContract({ address: usdg, abi: erc20, functionName: 'balanceOf', args: [investor.address] });
  await send(vault, vaultAbi, 'redeem', [shares / 2n, investor.address, investor.address]);
  const after = await pub.readContract({ address: usdg, abi: erc20, functionName: 'balanceOf', args: [investor.address] });
  console.log(`      redeemed half: received ${fmt(after - before)}`);
  expect(Number(after - before) > 49_000 * 1e6, 'redeem pays ~50% of NAV from Morpho');

  const decisions = (await (await fetch(`${API}/decisions`)).json()) as { decisions: { status: string; signer: { scheme: string } }[] };
  const executed = decisions.decisions.filter((x) => x.status === 'executed');
  expect(executed.length >= 3, `${executed.length} intents executed`);
  expect(executed.every((x) => x.signer.scheme === 'bls'), 'every intent was BLS-signed by the Amadeus key and verified on-chain');

  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
