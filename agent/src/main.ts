import 'dotenv/config';
import { loadConfig } from './config.js';
import { logger } from './log.js';
import { createBlsSigner, createEcdsaSigner, type IntentSigner } from './signing/signer.js';
import { createAmadeusAnchorer, noopAnchorer } from './amadeus/anchor.js';
import { createVaultClient } from './chain/vaultClient.js';
import { DecisionStore } from './store/decisions.js';
import { AgentEngine } from './engine/engine.js';
import { buildServer } from './api/server.js';
import { watchVaultFlows } from './indexer/depositWatcher.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const signer: IntentSigner =
    config.SIGNER_SCHEME === 'bls' ? createBlsSigner(config.AMADEUS_SEED_B58!) : createEcdsaSigner(config.AGENT_ECDSA_PRIVATE_KEY!);
  const anchorer =
    config.AMADEUS_ANCHOR_ENABLED && config.AMADEUS_SEED_B58
      ? createAmadeusAnchorer(config.AMADEUS_SEED_B58, config.AMADEUS_NETWORK, logger)
      : noopAnchorer;
  const vault = createVaultClient(config);
  const store = new DecisionStore(config.DATA_DIR);
  const engine = new AgentEngine({
    vault,
    signer,
    anchorer,
    store,
    log: logger,
    explorerUrl: config.EXPLORER_URL,
    intentTtlSeconds: config.INTENT_TTL_SECONDS,
  });

  const server = await buildServer({
    engine,
    store,
    signer: { scheme: signer.scheme, identity: signer.identity },
    demoToken: config.DEMO_API_TOKEN,
    webhookSecret: config.QUICKNODE_WEBHOOK_SECRET,
    corsOrigin: config.CORS_ORIGIN,
    vaultAddress: config.VAULT_ADDRESS,
    chainId: config.CHAIN_ID,
  });
  await server.listen({ port: config.AGENT_PORT, host: '0.0.0.0' });

  const stopWatcher = watchVaultFlows(vault.publicClient, vault.address, (reason) => void engine.trigger(reason), logger);
  const timer = setInterval(() => void engine.trigger('timer'), config.TICK_SECONDS * 1000);
  void engine.trigger('manual');
  logger.info({ port: config.AGENT_PORT, scheme: signer.scheme, identity: signer.identity, vault: vault.address }, 'agent started');

  const shutdown = async () => {
    clearInterval(timer);
    stopWatcher();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'agent failed to start');
  process.exit(1);
});
