import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { DripPolicy, registerDrip } from '../src/api/drip.js';

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const AMOUNT = 300_000_000_000_000n;
const limits = { amountWei: AMOUNT, budgetWei: AMOUNT * 2n, minIntervalMs: 10_000 };

describe('DripPolicy', () => {
  it('serves each empty wallet once, spaced, within the budget', () => {
    const p = new DripPolicy(limits);
    expect(p.check('nope', 0n, 0)).toMatchObject({ ok: false, status: 400 });
    expect(p.check(A, AMOUNT, 0)).toMatchObject({ ok: false, status: 409 }); // already funded
    expect(p.check(A, 0n, 0)).toEqual({ ok: true });
    p.record(A, 0);
    expect(p.check(A, 0n, 60_000)).toMatchObject({ ok: false, status: 409 }); // once per address
    expect(p.check(B, 0n, 5_000)).toMatchObject({ ok: false, status: 429, retryAfterSeconds: 5 });
    expect(p.check(B, 0n, 10_000)).toEqual({ ok: true });
    p.record(B, 10_000);
    expect(p.check('0x00000000000000000000000000000000000000c3', 0n, 99_000)).toMatchObject({ ok: false, status: 503 });
  });
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function server(send = vi.fn(async () => '0xhash')) {
  app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => {
    done(null, { json: JSON.parse(String(body)) });
  });
  registerDrip(app, { policy: new DripPolicy(limits), amountWei: AMOUNT, getBalance: async () => 0n, send, explorerUrl: 'https://x' });
  return { app, send };
}

describe('POST /drip', () => {
  it('sends gas once and refuses a second request for the same wallet', async () => {
    const { app, send } = await server();
    const first = await app.inject({ method: 'POST', url: '/drip', payload: { address: A } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ txHash: '0xhash', explorerUrl: 'https://x/tx/0xhash' });
    expect(send).toHaveBeenCalledWith(A, AMOUNT);
    expect((await app.inject({ method: 'POST', url: '/drip', payload: { address: A } })).statusCode).toBe(409);
  });

  it('rejects bad input and reports send failures without crashing', async () => {
    const { app } = await server(vi.fn(async () => {
      throw new Error('rpc down');
    }));
    expect((await app.inject({ method: 'POST', url: '/drip', payload: { address: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/drip', payload: { address: A } })).statusCode).toBe(502);
  });
});
