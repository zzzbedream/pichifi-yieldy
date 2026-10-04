/**
 * Public JSON-RPC endpoint for the hosted demo fork. Forwards only standard read/send
 * methods to the local anvil fork; anvil_*, evm_*, hardhat_*, debug_* and anything else
 * that could mutate the fork's state outside of signed transactions is rejected.
 */
import type { FastifyInstance } from 'fastify';

export const ALLOWED_RPC_METHODS = new Set([
  'eth_chainId',
  'net_version',
  'web3_clientVersion',
  'eth_syncing',
  'eth_blockNumber',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_estimateGas',
  'eth_call',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'eth_sendRawTransaction',
]);

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
}

/** Returns the first disallowed method in a single or batch request, or null if all are allowed. */
export function firstDisallowedMethod(body: unknown): string | null {
  const requests = Array.isArray(body) ? body : [body];
  if (requests.length === 0 || requests.length > 50) return 'invalid_batch';
  for (const r of requests as RpcRequest[]) {
    const method = r && typeof r === 'object' ? r.method : undefined;
    if (typeof method !== 'string' || !ALLOWED_RPC_METHODS.has(method)) return String(method);
  }
  return null;
}

export function registerRpcProxy(app: FastifyInstance, upstream: string): void {
  app.post('/rpc', async (request, reply) => {
    // Validate and forward the SAME parsed object (re-serialized): forwarding the raw text would
    // let parser differentials (e.g. duplicate "method" keys) smuggle a blocked method upstream.
    const body = (request.body as { json?: unknown } | undefined)?.json;
    const blocked = firstDisallowedMethod(body);
    if (blocked !== null) {
      return reply.code(403).send({ jsonrpc: '2.0', id: null, error: { code: -32601, message: `method not allowed: ${blocked}` } });
    }
    const res = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    reply.code(res.status).header('content-type', 'application/json');
    return reply.send(await res.text());
  });
}
