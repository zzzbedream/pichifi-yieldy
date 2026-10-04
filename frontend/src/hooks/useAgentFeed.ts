'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { appConfig } from '@/lib/config';
import { fetchAgentState, fetchDecisions, mergeDecision, type DecisionRecord } from '@/lib/agent';

/** Agent state + decision log, kept live through the agent's SSE stream. */
export function useAgentFeed() {
  const state = useQuery({ queryKey: ['agent-state'], queryFn: fetchAgentState, refetchInterval: 10_000, retry: 1 });
  // Polling backs up the SSE stream when a proxy in front of the agent buffers it.
  const initial = useQuery({ queryKey: ['agent-decisions'], queryFn: fetchDecisions, refetchInterval: 15_000, retry: 1 });
  const [live, setLive] = useState<DecisionRecord[] | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource(`${appConfig.agentApiUrl}/stream`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('decision', (event) => {
      const record = JSON.parse((event as MessageEvent<string>).data) as DecisionRecord;
      setLive((current) => mergeDecision(current ?? [], record));
    });
    return () => source.close();
  }, []);

  // Apply streamed records oldest-first on top of the fetched log, so the newest ends first.
  const decisions = useMemo(
    () => [...(live ?? [])].reverse().reduce(mergeDecision, initial.data?.decisions ?? []),
    [live, initial.data],
  );

  return {
    state: state.data,
    decisions,
    // Live = streaming, or reachable over polling (the feed still updates in that case).
    streaming: connected || state.isSuccess,
    error: state.error ?? initial.error,
    refetchState: state.refetch,
  };
}
