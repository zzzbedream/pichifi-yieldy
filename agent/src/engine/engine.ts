/**
 * Agent loop: market snapshot -> deterministic decision -> EIP-712 intent -> Amadeus
 * signature -> relay to the vault -> Amadeus audit anchor. Single-flight: one intent at a
 * time, because the vault requires the exact next nonce.
 */
import type { Hex } from 'viem';
import { decide, type Decision } from '../policy/policy.js';
import { intentDigest, type RebalanceIntent } from '../intent/eip712.js';
import { SCENARIOS, type ScenarioId } from '../market/scenarios.js';
import type { IntentSigner } from '../signing/signer.js';
import type { Anchorer } from '../amadeus/anchor.js';
import type { VaultClient, VaultSnapshot } from '../chain/vaultClient.js';
import type { DecisionRecord, DecisionStore } from '../store/decisions.js';
import type { Logger } from '../log.js';

/** Re-deploy idle cash (new deposits) once it exceeds this share of NAV. */
export const IDLE_DRIFT_BPS = 200n;

export interface EngineDeps {
  vault: VaultClient;
  signer: IntentSigner;
  anchorer: Anchorer;
  store: DecisionStore;
  log: Logger;
  explorerUrl: string;
  intentTtlSeconds: number;
}

export type Trigger = 'timer' | 'scenario' | 'deposit' | 'manual' | 'webhook';

/** Pure: does the vault need a new intent to match `decision`? */
export function needsRebalance(snapshot: VaultSnapshot, decision: Decision): boolean {
  if (snapshot.totalAssets === 0n || snapshot.paused) return false;
  const targetsDiffer =
    snapshot.regime !== decision.regime ||
    snapshot.morphoBps !== decision.morphoBps ||
    snapshot.uniswapBps !== decision.uniswapBps;
  const neverRebalanced = snapshot.lastRebalance === 0n;
  const idleDrift = snapshot.idle * 10_000n > snapshot.totalAssets * IDLE_DRIFT_BPS;
  return targetsDiffer || neverRebalanced || idleDrift;
}

/** Pure: seconds to wait before the vault's rate limit allows another intent (0 = now). */
export function secondsUntilAllowed(snapshot: VaultSnapshot, now: bigint): number {
  if (snapshot.lastRebalance === 0n) return 0;
  const next = snapshot.lastRebalance + snapshot.minRebalanceInterval;
  return now >= next ? 0 : Number(next - now);
}

export class AgentEngine {
  private scenario: ScenarioId = 'calm';
  private running = false;
  private pending: Trigger | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: EngineDeps) {}

  currentScenario(): ScenarioId {
    return this.scenario;
  }

  setScenario(scenario: ScenarioId): void {
    this.scenario = scenario;
    this.deps.log.info({ scenario }, 'scenario changed');
    void this.trigger('scenario');
  }

  /** Coalesces concurrent triggers into one follow-up run. */
  async trigger(reason: Trigger): Promise<void> {
    if (this.running) {
      this.pending = reason;
      return;
    }
    this.running = true;
    try {
      await this.run(reason);
    } catch (err) {
      this.deps.log.error({ err, reason }, 'agent run failed');
    } finally {
      this.running = false;
      const next = this.pending;
      this.pending = null;
      if (next) void this.trigger(next);
    }
  }

  private scheduleRetry(seconds: number): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.trigger('timer');
    }, (seconds + 2) * 1000);
  }

  private async run(reason: Trigger): Promise<void> {
    const { vault, signer, anchorer, store, log } = this.deps;
    const snapshot = await vault.snapshot();
    const inputs = SCENARIOS[this.scenario];
    const decision = decide(inputs);
    if (!needsRebalance(snapshot, decision)) return;

    const now = await vault.now();
    const wait = secondsUntilAllowed(snapshot, now);
    if (wait > 0) {
      log.info({ wait }, 'rate limited by vault; retrying');
      this.scheduleRetry(wait);
      return;
    }

    const intent: RebalanceIntent = {
      vault: vault.address,
      nonce: snapshot.nonce,
      deadline: now + BigInt(this.deps.intentTtlSeconds),
      regime: decision.regime,
      morphoBps: decision.morphoBps,
      uniswapBps: decision.uniswapBps,
      volBps: decision.volBps,
      inputsHash: decision.inputsHash,
      modelVersion: decision.modelVersion,
    };
    const digest = intentDigest(vault.chainId, intent);
    const onChain = await vault.onChainDigest(intent);
    if (onChain !== digest) throw new Error(`EIP-712 digest mismatch: local ${digest} vs vault ${onChain}`);

    const signed = await signer.sign(digest);
    const preflight = await vault.preflight(intent, signed.signature);
    if (!preflight.ok && preflight.retryable) {
      log.info({ error: preflight.errorName }, 'vault not ready for this intent yet; retrying');
      this.scheduleRetry(5);
      return;
    }
    let record = store.upsert(this.baseRecord(reason, decision, intent, digest, signed.proof));
    if (!preflight.ok) {
      store.upsert({ ...record, status: 'failed', error: `${preflight.errorName}: ${preflight.message}` });
      return;
    }
    log.info({ nonce: intent.nonce.toString(), regime: decision.regime }, 'intent signed; relaying');

    try {
      const receipt = await vault.relay(intent, signed.signature);
      record = store.upsert({
        ...record,
        status: receipt.status === 'success' ? 'executed' : 'failed',
        chain: {
          txHash: receipt.txHash,
          blockNumber: receipt.blockNumber.toString(),
          status: receipt.status,
          explorerUrl: `${this.deps.explorerUrl}/tx/${receipt.txHash}`,
        },
      });
    } catch (err) {
      store.upsert({ ...record, status: 'failed', error: errorMessage(err) });
      throw err;
    }

    const anchor = await anchorer.anchor(intent.nonce, digest);
    if (anchor) store.upsert({ ...record, amadeus: anchor });
  }

  private baseRecord(trigger: Trigger, decision: Decision, intent: RebalanceIntent, digest: Hex, proof: Hex): DecisionRecord {
    return {
      id: `${intent.nonce.toString()}-${digest.slice(2, 10)}`,
      createdAt: new Date().toISOString(),
      trigger,
      scenario: this.scenario,
      inputs: SCENARIOS[this.scenario],
      decision,
      intent: { nonce: intent.nonce.toString(), deadline: intent.deadline.toString(), digest },
      signer: { scheme: this.deps.signer.scheme, identity: this.deps.signer.identity, proof },
      amadeus: null,
      chain: null,
      status: 'signed',
    };
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return (err as Error & { shortMessage?: string }).shortMessage ?? err.message;
  return 'Unexpected error';
}
