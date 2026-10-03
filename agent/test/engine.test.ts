import { describe, expect, it, vi } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { pino } from 'pino';
import { AgentEngine, needsRebalance, secondsUntilAllowed } from '../src/engine/engine.js';
import { decide } from '../src/policy/policy.js';
import { SCENARIOS } from '../src/market/scenarios.js';
import { intentDigest } from '../src/intent/eip712.js';
import { DecisionStore } from '../src/store/decisions.js';
import { createEcdsaSigner } from '../src/signing/signer.js';
import type { VaultClient, VaultSnapshot } from '../src/chain/vaultClient.js';
import type { Anchorer } from '../src/amadeus/anchor.js';

const silent = pino({ level: 'silent' });
const VAULT = '0x00000000000000000000000000000000000000aa' as const;

function snapshot(overrides: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    nonce: 0n,
    totalAssets: 100_000_000_000n,
    idle: 100_000_000_000n,
    morpho: 0n,
    uniswap: 0n,
    regime: 0,
    morphoBps: 0,
    uniswapBps: 0,
    lastRebalance: 0n,
    minRebalanceInterval: 30n,
    paused: false,
    ...overrides,
  };
}

function fakeVault(snap: VaultSnapshot, relayResult: 'success' | 'reverted' | Error = 'success'): VaultClient & { relayed: number } {
  const v = {
    address: VAULT,
    chainId: 46630,
    publicClient: {} as never,
    relayed: 0,
    async snapshot() {
      return snap;
    },
    async onChainDigest(i: Parameters<VaultClient['onChainDigest']>[0]) {
      return intentDigest(46630, i);
    },
    async relay() {
      v.relayed += 1;
      if (relayResult instanceof Error) throw relayResult;
      return { txHash: keccak256(toHex('tx')) as Hex, blockNumber: 7n, status: relayResult };
    },
    async now() {
      return 1_790_000_000n;
    },
  };
  return v;
}

function engineWith(vault: VaultClient, anchorer: Anchorer = { anchor: async () => ({ txHash: 'ama-tx', explorerUrl: 'https://x/tx/ama-tx' }) }) {
  const store = new DecisionStore(null);
  const signer = createEcdsaSigner('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const engine = new AgentEngine({ vault, signer, anchorer, store, log: silent, explorerUrl: 'https://explorer', intentTtlSeconds: 300 });
  return { engine, store };
}

describe('needsRebalance', () => {
  const riskOn = decide(SCENARIOS.calm);
  it('skips empty or paused vaults', () => {
    expect(needsRebalance(snapshot({ totalAssets: 0n }), riskOn)).toBe(false);
    expect(needsRebalance(snapshot({ paused: true }), riskOn)).toBe(false);
  });
  it('acts on first deposit, regime change and idle drift', () => {
    expect(needsRebalance(snapshot(), riskOn)).toBe(true);
    const settled = snapshot({ lastRebalance: 1n, morphoBps: 5_000, uniswapBps: 5_000, idle: 0n });
    expect(needsRebalance(settled, riskOn)).toBe(false);
    expect(needsRebalance(settled, decide(SCENARIOS.recession))).toBe(true);
    expect(needsRebalance({ ...settled, idle: 5_000_000_000n }, riskOn)).toBe(true);
  });
});

describe('secondsUntilAllowed', () => {
  it('respects the vault rate limit', () => {
    expect(secondsUntilAllowed(snapshot(), 100n)).toBe(0);
    expect(secondsUntilAllowed(snapshot({ lastRebalance: 100n }), 110n)).toBe(20);
    expect(secondsUntilAllowed(snapshot({ lastRebalance: 100n }), 131n)).toBe(0);
  });
});

describe('AgentEngine', () => {
  it('signs, relays and anchors an intent after a deposit', async () => {
    const vault = fakeVault(snapshot());
    const { engine, store } = engineWith(vault);
    await engine.trigger('deposit');
    const record = store.latest()!;
    expect(vault.relayed).toBe(1);
    expect(record.status).toBe('executed');
    expect(record.decision.regime).toBe(0);
    expect(record.chain?.explorerUrl).toContain('/tx/');
    expect(record.amadeus?.txHash).toBe('ama-tx');
    expect(record.signer.scheme).toBe('ecdsa');
  });

  it('switching scenario produces a new risk-off intent', async () => {
    const vault = fakeVault(snapshot());
    const { engine, store } = engineWith(vault);
    engine.setScenario('recession');
    await vi.waitFor(() => expect(store.latest()?.status).toBe('executed'));
    expect(store.latest()!.decision.morphoBps).toBe(10_000);
    expect(engine.currentScenario()).toBe('recession');
  });

  it('records failures without crashing', async () => {
    const vault = fakeVault(snapshot(), new Error('execution reverted: NavLossExceeded'));
    const { engine, store } = engineWith(vault);
    await engine.trigger('manual');
    expect(store.latest()!.status).toBe('failed');
    expect(store.latest()!.error).toContain('NavLossExceeded');
  });

  it('does nothing when the vault already matches the decision', async () => {
    const vault = fakeVault(snapshot({ lastRebalance: 1n, morphoBps: 5_000, uniswapBps: 5_000, idle: 0n }));
    const { engine, store } = engineWith(vault);
    await engine.trigger('timer');
    expect(vault.relayed).toBe(0);
    expect(store.list()).toHaveLength(0);
  });

  it('refuses to sign when the on-chain digest differs (domain mismatch)', async () => {
    const vault = { ...fakeVault(snapshot()), onChainDigest: async () => keccak256(toHex('wrong')) as Hex };
    const { engine, store } = engineWith(vault);
    await engine.trigger('manual');
    expect(store.list()).toHaveLength(0);
  });
});
