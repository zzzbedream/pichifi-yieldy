/**
 * Agent HTTP API consumed by the dashboard.
 *   GET  /health            liveness
 *   GET  /state             signer identity, scenario, latest decision
 *   GET  /decisions         decision log (newest first)
 *   GET  /stream            Server-Sent Events: `decision` on every change
 *   POST /scenario          demo control (Bearer DEMO_API_TOKEN): switch market scenario
 *   POST /webhooks/quicknode  Quicknode Streams/Webhooks (HMAC-SHA256) -> trigger the agent
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { SCENARIO_IDS, SCENARIOS, isScenarioId, type ScenarioId } from '../market/scenarios.js';
import type { DecisionRecord, DecisionStore } from '../store/decisions.js';
import type { Trigger } from '../engine/engine.js';

export interface ApiEngine {
  currentScenario(): ScenarioId;
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
      done(new Error('Invalid JSON body'), undefined);
    }
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/state', async () => ({
    signer: deps.signer,
    scenario: deps.engine.currentScenario(),
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
    const send = (record: DecisionRecord) => reply.raw.write(`event: decision\ndata: ${JSON.stringify(record)}\n\n`);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    deps.store.events.on('decision', send);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      deps.store.events.off('decision', send);
    });
  });

  app.post('/scenario', async (request, reply) => {
    const auth = request.headers.authorization ?? '';
    if (!safeEqual(auth, `Bearer ${deps.demoToken}`)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = scenarioBody.safeParse((request.body as { json?: unknown } | undefined)?.json);
    if (!parsed.success) return reply.code(400).send({ error: 'scenario must be one of ' + SCENARIO_IDS.join(', ') });
    deps.engine.setScenario(parsed.data.scenario as ScenarioId);
    return { scenario: parsed.data.scenario };
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
