import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer, verifyWebhookSignature } from '../src/api/server.js';
import { DecisionStore } from '../src/store/decisions.js';
import type { ScenarioId } from '../src/market/scenarios.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'demo-token-0123456789';
const SECRET = 'qn-secret-123';

function setup() {
  let scenario: ScenarioId = 'calm';
  const engine = {
    currentScenario: () => scenario,
    setScenario: vi.fn((s: ScenarioId) => {
      scenario = s;
    }),
    trigger: vi.fn(async () => {}),
  };
  const store = new DecisionStore(null);
  return { engine, store };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function server() {
  const deps = setup();
  app = await buildServer({
    ...deps,
    signer: { scheme: 'bls', identity: 'AmadeusPk' },
    demoToken: TOKEN,
    webhookSecret: SECRET,
    corsOrigin: 'http://localhost:3000',
    vaultAddress: '0x00000000000000000000000000000000000000aa',
    chainId: 46630,
  });
  return { app, ...deps };
}

describe('agent API', () => {
  it('exposes state and decisions', async () => {
    const { app } = await server();
    const state = await app.inject({ method: 'GET', url: '/state' });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ scenario: 'calm', chainId: 46630, signer: { scheme: 'bls' } });
    const decisions = await app.inject({ method: 'GET', url: '/decisions' });
    expect(decisions.json()).toEqual({ decisions: [] });
  });

  it('requires the demo token to switch scenarios and validates the body', async () => {
    const { app, engine } = await server();
    const unauthorized = await app.inject({ method: 'POST', url: '/scenario', payload: { scenario: 'recession' } });
    expect(unauthorized.statusCode).toBe(401);
    const bad = await app.inject({
      method: 'POST',
      url: '/scenario',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { scenario: 'moon' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'POST',
      url: '/scenario',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { scenario: 'recession' },
    });
    expect(ok.statusCode).toBe(200);
    expect(engine.setScenario).toHaveBeenCalledWith('recession');
  });

  it('accepts only HMAC-signed Quicknode webhooks', async () => {
    const { app, engine } = await server();
    const body = JSON.stringify({ logs: [] });
    const good = createHmac('sha256', SECRET).update(body).digest('hex');
    const rejected = await app.inject({ method: 'POST', url: '/webhooks/quicknode', payload: body, headers: { 'content-type': 'application/json', 'x-qn-signature': 'bad' } });
    expect(rejected.statusCode).toBe(401);
    const accepted = await app.inject({ method: 'POST', url: '/webhooks/quicknode', payload: body, headers: { 'content-type': 'application/json', 'x-qn-signature': good } });
    expect(accepted.statusCode).toBe(200);
    expect(engine.trigger).toHaveBeenCalledWith('webhook');
  });

  it('verifyWebhookSignature accepts sha256= prefix and rejects missing signatures', () => {
    const sig = createHmac('sha256', SECRET).update('x').digest('hex');
    expect(verifyWebhookSignature(SECRET, 'x', `sha256=${sig}`)).toBe(true);
    expect(verifyWebhookSignature(SECRET, 'x', undefined)).toBe(false);
  });
});

describe('config', () => {
  const base = {
    RPC_URL: 'https://rpc.testnet.chain.robinhood.com',
    RELAYER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    VAULT_ADDRESS: '0x00000000000000000000000000000000000000aa',
    DEMO_API_TOKEN: TOKEN,
    SIGNER_SCHEME: 'ecdsa',
    AGENT_ECDSA_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
  };

  it('parses a valid environment with defaults', () => {
    const config = loadConfig(base);
    expect(config.CHAIN_ID).toBe(46630);
    expect(config.AMADEUS_ANCHOR_ENABLED).toBe(false);
  });

  it('fails fast with readable messages', () => {
    expect(() => loadConfig({ ...base, VAULT_ADDRESS: 'nope' })).toThrow(/VAULT_ADDRESS/);
    expect(() => loadConfig({ ...base, SIGNER_SCHEME: 'bls' })).toThrow(/AMADEUS_SEED_B58/);
    expect(() => loadConfig({ ...base, AGENT_ECDSA_PRIVATE_KEY: '' })).toThrow(/AGENT_ECDSA_PRIVATE_KEY/);
  });
});
