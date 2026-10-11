/**
 * Agent HTTP API consumed by the dashboard.
 *   GET  /health            liveness
 *   GET  /state             signer identity, scenario, latest decision
 *   GET  /decisions         decision log (newest first)
 *   GET  /stream            Server-Sent Events: `decision` on every change
 *   POST /scenario          switch market scenario: presenter (Bearer DEMO_API_TOKEN), or public
 *                           stress test when enabled (global cooldown, auto-return to live inputs)
 *   POST /webhooks/quicknode  Quicknode Streams/Webhooks (HMAC-SHA256) -> trigger the agent
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { SCENARIO_IDS, SCENARIOS, isScenarioId, type MarketInputs, type ScenarioId } from '../market/scenarios.js';
import type { DecisionRecord, DecisionStore } from '../store/decisions.js';
import type { Trigger } from '../engine/engine.js';
import { registerRpcProxy } from './rpcProxy.js';
import type { PublicStress } from './stressGate.js';
import { registerDrip, type DripDeps } from './drip.js';

export interface ApiEngine {
  currentScenario(): ScenarioId;
  /** Inputs of the active scenario (live snapshot or stress test); null while loading. */
  currentInputs?(): MarketInputs | null;
  setScenario(scenario: ScenarioId): void;
  trigger(reason: Trigger): Promise<void>;
}

export interface ApiDeps {
  engine: ApiEngine;
  store: DecisionStore;
  signer: { scheme: 'bls' | 'ecdsa'; identity: string };
  demoToken: string;
  webhookSecret?: string;
  corsOrigin: string;
  vaultAddress: string;
  chainId: number;
  /** When set (hosted fork demo), exposes a method-filtered JSON-RPC proxy at POST /rpc. */
  rpcUpstream?: string;
  /** When set, scenario switches are open to everyone (cooldown, auto-revert, gas floor). */
  publicStress?: PublicStress;
  /** When set, exposes POST /drip (test gas for judges). */
  drip?: DripDeps;
}

const scenarioBody = z.object({ scenario: z.string().refine(isScenarioId, 'unknown scenario') });

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function verifyWebhookSignature(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(expected, signature.replace(/^sha256=/, ''));
}

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const allowedOrigins = deps.corsOrigin.split(',').map((o) => o.trim());
  await app.register(cors, { origin: allowedOrigins });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      done(null, { raw: text, json: text.length ? JSON.parse(text) : {} });
    } catch {
      done(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }), undefined);
    }
  });

  app.get('/health', async () => ({ ok: true }));

  if (deps.rpcUpstream) registerRpcProxy(app, deps.rpcUpstream);
  if (deps.drip) registerDrip(app, deps.drip);

  app.get('/state', async () => ({
    signer: deps.signer,
    scenario: deps.engine.currentScenario(),
    inputs: deps.engine.currentInputs?.() ?? null,
    scenarios: SCENARIO_IDS.map((id) => SCENARIOS[id]),
    vault: deps.vaultAddress,
    chainId: deps.chainId,
    latest: deps.store.latest() ?? null,
  }));

  app.get('/decisions', async () => ({ decisions: deps.store.list() }));

  app.get('/stream', (request, reply) => {
    // Take over the socket: Fastify must not try to send its own response on this route.
    reply.hijack();
    const origin = request.headers.origin;
    const allowed = origin && allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...allowed,
    });
    // Flush headers immediately so EventSource fires `open` without waiting for a heartbeat.
    reply.raw.write(': connected\n\n');
    const write = (chunk: string) => {
      if (!reply.raw.destroyed && reply.raw.writable) reply.raw.write(chunk);
    };
    const send = (record: DecisionRecord) => write(`event: decision\ndata: ${JSON.stringify(record)}\n\n`);
    const heartbeat = setInterval(() => write(': ping\n\n'), 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      deps.store.events.off('decision', send);
    };
    deps.store.events.on('decision', send);
    // A socket destroyed by a proxy/client must never surface as an uncaught 'error' event.
    reply.raw.on('error', cleanup);
    request.raw.on('close', cleanup);
  });

  let revertTimer: NodeJS.Timeout | null = null;
  app.addHook('onClose', async () => {
    if (revertTimer) clearTimeout(revertTimer);
  });

  app.post('/scenario', async (request, reply) => {
    const auth = request.headers.authorization ?? '';
    const isPresenter = safeEqual(auth, `Bearer ${deps.demoToken}`);
    const pub = deps.publicStress;
    if (!isPresenter && !pub) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = scenarioBody.safeParse((request.body as { json?: unknown } | undefined)?.json);
    if (!parsed.success) return reply.code(400).send({ error: 'scenario must be one of live, ' + SCENARIO_IDS.join(', ') });
    const scenario = parsed.data.scenario as ScenarioId;

    if (!isPresenter && pub) {
      // Cheap cooldown first, so floods of requests never reach the RPC balance check.
      const gate = pub.gate.check(Date.now());
      if (!gate.ok) {
        reply.header('retry-after', String(gate.retryAfterSeconds));
        return reply
          .code(429)
          .send({ error: `Someone just ran a stress test. Try again in ${gate.retryAfterSeconds}s.`, retryAfter: gate.retryAfterSeconds });
      }
      pub.gate.record(Date.now());
      if (!(await pub.canSpend())) {
        return reply.code(503).send({ error: 'Public stress tests are paused: the relayer is low on test gas.' });
      }
    }

    deps.engine.setScenario(scenario);
    if (revertTimer) clearTimeout(revertTimer);
    revertTimer = null;
    let revertsAt: string | null = null;
    if (pub && scenario !== pub.revertTo) {
      revertsAt = new Date(Date.now() + pub.revertMs).toISOString();
      revertTimer = setTimeout(() => {
        revertTimer = null;
        if (deps.engine.currentScenario() === scenario) deps.engine.setScenario(pub.revertTo);
      }, pub.revertMs);
    }
    return { scenario, revertsAt };
  });

  app.post('/webhooks/quicknode', async (request, reply) => {
    if (!deps.webhookSecret) return reply.code(404).send({ error: 'webhook disabled' });
    const raw = (request.body as { raw?: string } | undefined)?.raw ?? '';
    const signature = request.headers['x-qn-signature'] as string | undefined;
    if (!verifyWebhookSignature(deps.webhookSecret, raw, signature)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }
    void deps.engine.trigger('webhook');
    return { accepted: true };
  });

  return app;
}
