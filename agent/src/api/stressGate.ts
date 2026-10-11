/**
 * Public stress tests: anyone (e.g. a judge) can switch the agent to a stress scenario and watch
 * a real on-chain rebalance, without the presenter token. Guarded by a global cooldown, an
 * automatic return to live market inputs, and a relayer gas floor.
 */

export interface StressGateOptions {
  cooldownMs: number;
}

export type GateResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Pure global cooldown between public scenario switches. */
export class StressGate {
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: StressGateOptions) {}

  check(nowMs: number): GateResult {
    const wait = this.last + this.opts.cooldownMs - nowMs;
    return wait <= 0 ? { ok: true } : { ok: false, retryAfterSeconds: Math.ceil(wait / 1000) };
  }

  record(nowMs: number): void {
    this.last = nowMs;
  }
}

export interface PublicStress {
  gate: StressGate;
  /** Returns to this scenario after `revertMs` (live market inputs). */
  revertTo: 'live';
  revertMs: number;
  /** False when the relayer is too low on gas to pay for public rebalances. */
  canSpend(): Promise<boolean>;
}
