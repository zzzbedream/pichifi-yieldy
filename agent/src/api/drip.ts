/**
 * Test-gas drip for judges: POST /drip {address} sends a small amount of Robinhood testnet ETH
 * from a dedicated drip wallet (never the relayer, so nonces cannot collide with rebalances).
 * Limits: once per address, only to near-empty wallets, a global interval, and a total budget.
 */
import type { FastifyInstance } from 'fastify';
import { isAddress, type Address } from 'viem';

export interface DripLimits {
  amountWei: bigint;
  budgetWei: bigint;
  minIntervalMs: number;
}

export type DripVerdict =
  | { ok: true }
  | { ok: false; status: 400 | 409 | 429 | 503; error: string; retryAfterSeconds?: number };

/** Pure bookkeeping of who got gas, when, and how much is left. */
export class DripPolicy {
  private readonly served = new Set<string>();
  private spent = 0n;
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly limits: DripLimits) {}

  check(address: string, recipientBalanceWei: bigint, nowMs: number): DripVerdict {
    if (!isAddress(address)) return { ok: false, status: 400, error: 'Invalid address.' };
    if (this.served.has(address.toLowerCase())) return { ok: false, status: 409, error: 'This wallet already received test gas.' };
    if (recipientBalanceWei >= this.limits.amountWei / 2n) {
      return { ok: false, status: 409, error: 'This wallet already has enough test gas.' };
    }
    if (this.spent + this.limits.amountWei > this.limits.budgetWei) {
      return { ok: false, status: 503, error: 'The test-gas budget is used up. Use the official faucet.' };
    }
    const wait = this.last + this.limits.minIntervalMs - nowMs;
    if (wait > 0) return { ok: false, status: 429, error: 'Busy, try again shortly.', retryAfterSeconds: Math.ceil(wait / 1000) };
    return { ok: true };
  }

  record(address: string, nowMs: number): void {
    this.served.add(address.toLowerCase());
    this.spent += this.limits.amountWei;
    this.last = nowMs;
  }
}

export interface DripDeps {
  policy: DripPolicy;
  amountWei: bigint;
  getBalance(address: Address): Promise<bigint>;
  /** Sends `amountWei` and resolves with the transaction hash once mined. */
  send(to: Address, amountWei: bigint): Promise<string>;
  explorerUrl: string;
}

export function registerDrip(app: FastifyInstance, deps: DripDeps): void {
  app.post('/drip', async (request, reply) => {
    const body = (request.body as { json?: { address?: unknown } } | undefined)?.json;
    const address = typeof body?.address === 'string' ? body.address : '';
    if (!isAddress(address)) return reply.code(400).send({ error: 'Invalid address.' });

    // Cheap early rejection before any network call.
    const preliminary = deps.policy.check(address, 0n, Date.now());
    if (!preliminary.ok) {
      if (preliminary.retryAfterSeconds) reply.header('retry-after', String(preliminary.retryAfterSeconds));
      return reply.code(preliminary.status).send({ error: preliminary.error });
    }
    const balance = await deps.getBalance(address);
    // check + record run synchronously (no await in between): concurrent requests cannot both pass.
    const verdict = deps.policy.check(address, balance, Date.now());
    if (!verdict.ok) return reply.code(verdict.status).send({ error: verdict.error });
    deps.policy.record(address, Date.now());

    try {
      const txHash = await deps.send(address, deps.amountWei);
      return { txHash, explorerUrl: `${deps.explorerUrl}/tx/${txHash}` };
    } catch (err) {
      request.log.error({ err }, 'drip failed');
      return reply.code(502).send({ error: 'Could not send test gas right now. Use the official faucet.' });
    }
  });
}
