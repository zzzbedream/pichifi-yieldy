import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { StressGate } from '../src/api/stressGate.js';
import { DecisionStore } from '../src/store/decisions.js';
import type { ScenarioId } from '../src/market/scenarios.js';

const TOKEN = 'demo-token-0123456789';

describe('StressGate', () => {
  it('enforces a global cooldown between public switches', () => {
    const gate = new StressGate({ cooldownMs: 120_000 });
    expect(gate.check(0)).toEqual({ ok: true });
    gate.record(0);
    expect(gate.check(30_000)).toEqual({ ok: false, retryAfterSeconds: 90 });
    expect(gate.check(120_000)).toEqual({ ok: true });
  });
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function publicServer(canSpend = true, revertMs = 60_000) {
  let scenario: ScenarioId = 'live';
  const engine = {
    currentScenario: () => scenario,
    setScenario: vi.fn((s: ScenarioId) => {
      scenario = s;
    }),
    trigger: vi.fn(async () => {}),
  };
  app = await buildServer({
    engine,
    store: new DecisionStore(null),
    signer: { scheme: 'bls', identity: 'AmadeusPk' },
    demoToken: TOKEN,
    corsOrigin: 'http://localhost:3000',
    vaultAddress: '0x00000000000000000000000000000000000000aa',
    chainId: 46630,
    publicStress: { gate: new StressGate({ cooldownMs: 120_000 }), revertTo: 'live', revertMs, canSpend: async () => canSpend },
  });
  return { app, engine, current: () => scenario };
}

const post = (a: FastifyInstance, scenario: string, auth?: string) =>
  a.inject({ method: 'POST', url: '/scenario', headers: auth ? { authorization: auth } : {}, payload: { scenario } });

describe('public stress tests', () => {
  it('lets anyone switch once, then rate-limits; the presenter bypasses the cooldown', async () => {
    const { app, current } = await publicServer();
    const first = await post(app, 'earnings_volatility');
    expect(first.statusCode).toBe(200);
    expect(first.json().revertsAt).toEqual(expect.any(String));
    expect(current()).toBe('earnings_volatility');

    const second = await post(app, 'recession');
    expect(second.statusCode).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    expect(current()).toBe('earnings_volatility');

    expect((await post(app, 'recession', `Bearer ${TOKEN}`)).statusCode).toBe(200);
    expect(current()).toBe('recession');
  });

  it('pauses public switches when the relayer is low on gas', async () => {
    const { app, current } = await publicServer(false);
    expect((await post(app, 'recession')).statusCode).toBe(503);
    expect(current()).toBe('live');
  });

  it('returns to live market inputs automatically', async () => {
    const { app, current } = await publicServer(true, 50);
    await post(app, 'recession');
    expect(current()).toBe('recession');
    await new Promise((r) => setTimeout(r, 120));
    expect(current()).toBe('live');
  });

  it('still validates the scenario', async () => {
    const { app } = await publicServer();
    expect((await post(app, 'moon')).statusCode).toBe(400);
  });
});
