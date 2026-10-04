/**
 * Environment configuration, validated at startup. Fails fast with a clear message;
 * secrets are never logged.
 */
import { z } from 'zod';
import { isAddress, isHex, type Address, type Hex } from 'viem';

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), 'must be a 0x-prefixed 20-byte address')
  .transform((v) => v as Address);
const privateKey = z
  .string()
  .refine((v) => isHex(v) && v.length === 66, 'must be a 0x-prefixed 32-byte hex key')
  .transform((v) => v as Hex);
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

export const configSchema = z.object({
  CHAIN_ID: z.coerce.number().int().positive().default(46630),
  RPC_URL: z.string().url(),
  WSS_URL: optional(z.string().url()),
  EXPLORER_URL: z.string().url().default('https://explorer.testnet.chain.robinhood.com'),

  RELAYER_PRIVATE_KEY: privateKey,
  SIGNER_SCHEME: z.enum(['bls', 'ecdsa']).default('bls'),
  AGENT_ECDSA_PRIVATE_KEY: optional(privateKey),
  AMADEUS_SEED_B58: optional(z.string().min(32)),
  AMADEUS_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  AMADEUS_ANCHOR_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  VAULT_ADDRESS: address,

  AGENT_PORT: z.coerce.number().int().positive().default(8787),
  DEMO_API_TOKEN: z.string().min(16),
  QUICKNODE_WEBHOOK_SECRET: optional(z.string().min(8)),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  TICK_SECONDS: z.coerce.number().int().min(5).default(20),
  INTENT_TTL_SECONDS: z.coerce.number().int().min(30).default(300),
  DATA_DIR: z.string().default('data'),
  /** Hosted fork demo only: local anvil URL exposed (method-filtered) at POST /rpc. */
  FORK_RPC_PROXY_UPSTREAM: optional(z.string().url()),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid agent configuration:\n${issues}`);
  }
  const config = parsed.data;
  if (config.SIGNER_SCHEME === 'bls' && !config.AMADEUS_SEED_B58) {
    throw new Error('Invalid agent configuration:\n  - AMADEUS_SEED_B58: required when SIGNER_SCHEME=bls');
  }
  if (config.SIGNER_SCHEME === 'ecdsa' && !config.AGENT_ECDSA_PRIVATE_KEY) {
    throw new Error('Invalid agent configuration:\n  - AGENT_ECDSA_PRIVATE_KEY: required when SIGNER_SCHEME=ecdsa');
  }
  return config;
}
