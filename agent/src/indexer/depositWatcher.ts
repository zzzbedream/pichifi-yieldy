/**
 * Watches the vault's Deposit/Withdraw events (Quicknode WSS endpoint when configured,
 * HTTP polling otherwise) and wakes the agent so new capital is allocated immediately.
 * Quicknode Streams can push the same events to `POST /webhooks/quicknode`.
 */
import type { PublicClient, Address } from 'viem';
import { vaultAbi } from '../chain/vaultAbi.js';
import type { Trigger } from '../engine/engine.js';
import type { Logger } from '../log.js';

export function watchVaultFlows(
  client: PublicClient,
  vault: Address,
  onFlow: (reason: Trigger) => void,
  log: Logger,
): () => void {
  const unwatchDeposit = client.watchContractEvent({
    address: vault,
    abi: vaultAbi,
    eventName: 'Deposit',
    pollingInterval: 2_000,
    onLogs: (logs) => {
      log.info({ count: logs.length }, 'deposit detected');
      onFlow('deposit');
    },
    onError: (err) => log.warn({ err }, 'deposit watcher error'),
  });
  return () => unwatchDeposit();
}
