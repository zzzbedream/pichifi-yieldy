'use client';

import { useState } from 'react';
import { useConnection, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import type { Address, Hash } from 'viem';
import { appConfig } from '@/lib/config';
import { erc20Abi, vaultAbi } from '@/lib/abis';
import { formatAmount, formatUsd, parseUnitsSafe, SHARE_DECIMALS, USDG_DECIMALS } from '@/lib/format';
import { useWalletData } from '@/hooks/useVaultData';
import ui from './ui.module.css';

type Mode = 'deposit' | 'redeem';

export function PositionPanel({ sharePrice }: { sharePrice?: bigint }) {
  const { address, isConnected } = useConnection();
  const wallet = useWalletData(address);
  const write = useWriteContract();
  const [mode, setMode] = useState<Mode>('deposit');
  const [amount, setAmount] = useState('');
  const [pendingHash, setPendingHash] = useState<Hash | undefined>();
  const [error, setError] = useState<string | null>(null);
  const receipt = useWaitForTransactionReceipt({ hash: pendingHash, query: { enabled: Boolean(pendingHash) } });

  const vault = appConfig.contracts.vault as Address;
  const usdg = appConfig.contracts.usdg as Address;
  const decimals = mode === 'deposit' ? USDG_DECIMALS : SHARE_DECIMALS;
  const parsed = parseUnitsSafe(amount, decimals);
  const balance = mode === 'deposit' ? wallet.usdgBalance : wallet.shares;
  const needsApproval = mode === 'deposit' && parsed !== null && (wallet.allowance ?? 0n) < parsed;
  const isBusy = write.isPending || (Boolean(pendingHash) && receipt.isLoading);
  const isTooMuch = parsed !== null && balance !== undefined && parsed > balance;
  const canSubmit = isConnected && parsed !== null && parsed > 0n && !isTooMuch && !isBusy;

  async function send(request: Parameters<typeof write.mutateAsync>[0]) {
    setError(null);
    setPendingHash(undefined);
    try {
      const hash = await write.mutateAsync(request);
      setPendingHash(hash);
    } catch (err) {
      setError(err instanceof Error ? (err as Error & { shortMessage?: string }).shortMessage ?? err.message : 'Transaction failed');
    }
  }

  function handleSubmit() {
    if (parsed === null || !address) return;
    if (needsApproval) {
      void send({ address: usdg, abi: erc20Abi, functionName: 'approve', args: [vault, parsed] });
    } else if (mode === 'deposit') {
      void send({ address: vault, abi: vaultAbi, functionName: 'deposit', args: [parsed, address] });
    } else {
      void send({ address: vault, abi: vaultAbi, functionName: 'redeem', args: [parsed, address, address] });
    }
  }

  function handleFaucet() {
    void send({ address: usdg, abi: erc20Abi, functionName: 'faucet', args: [100_000n * 10n ** 6n] });
  }

  const label = needsApproval ? 'Approve USDG' : mode === 'deposit' ? 'Deposit' : 'Redeem';
  const positionValue = wallet.shares !== undefined && sharePrice !== undefined ? (wallet.shares * sharePrice) / 10n ** 12n : undefined;

  return (
    <section className={ui.panel} aria-labelledby="position-heading">
      <h2 id="position-heading">Your position</h2>
      <div className={ui.rows}>
        <div className={ui.row}>
          <span>USDG in wallet</span>
          <span className="mono">{formatUsd(wallet.usdgBalance)}</span>
        </div>
        <div className={ui.row}>
          <span>Vault shares (ayvUSDG)</span>
          <span className="mono">{formatAmount(wallet.shares, SHARE_DECIMALS, 4)}</span>
        </div>
        <div className={ui.row}>
          <span>Position value</span>
          <span className="mono">{formatUsd(positionValue)}</span>
        </div>
      </div>

      <div className={ui.actions} role="tablist" aria-label="Action">
        {(['deposit', 'redeem'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? ui.button : `${ui.button} ${ui.ghost}`}
            onClick={() => {
              setMode(m);
              setAmount('');
              setPendingHash(undefined);
              setError(null);
            }}
          >
            {m === 'deposit' ? 'Deposit USDG' : 'Redeem shares'}
          </button>
        ))}
      </div>

      <div className={ui.field} style={{ marginTop: 'var(--space-4)' }}>
        <label className="eyebrow" htmlFor="amount">
          {mode === 'deposit' ? 'Amount (USDG)' : 'Shares (ayvUSDG)'}
        </label>
        <div className={ui.inputRow}>
          <input
            id="amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <button
            type="button"
            className={ui.maxButton}
            disabled={balance === undefined}
            onClick={() => balance !== undefined && setAmount(formatAmount(balance, decimals, decimals).replace(/,/g, ''))}
          >
            MAX
          </button>
        </div>
      </div>

      <div className={ui.actions}>
        <button type="button" className={ui.button} disabled={!canSubmit} onClick={handleSubmit}>
          {isBusy ? 'Confirming…' : label}
        </button>
        {mode === 'deposit' && (wallet.faucetCap ?? 0n) > 0n && (
          <button type="button" className={`${ui.button} ${ui.ghost}`} disabled={!isConnected || isBusy} onClick={handleFaucet}>
            Get 100k test USDG
          </button>
        )}
      </div>

      {!isConnected && <p className={ui.notice}>Connect MetaMask or Rabby on Robinhood Chain testnet to deposit.</p>}
      {isTooMuch && <p className={ui.error}>Amount exceeds your balance.</p>}
      {amount !== '' && parsed === null && <p className={ui.error}>Enter a valid amount.</p>}
      {receipt.isSuccess && <p className={ui.notice}>Confirmed. The agent reacts to deposits automatically.</p>}
      {error && <p className={ui.error}>{error}</p>}
    </section>
  );
}
