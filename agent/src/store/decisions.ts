/**
 * Decision log: every intent the agent produced, with its inputs, proof, Amadeus anchor and
 * on-chain result. Kept in memory for the API/SSE and persisted to `<dataDir>/decisions.json`.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import type { Decision } from '../policy/policy.js';
import type { MarketInputs, ScenarioId } from '../market/scenarios.js';
import type { AnchorResult } from '../amadeus/anchor.js';

export type DecisionStatus = 'signed' | 'executed' | 'failed';

export interface DecisionRecord {
  id: string;
  createdAt: string;
  trigger: string;
  scenario: ScenarioId;
  inputs: MarketInputs;
  decision: Decision;
  intent: { nonce: string; deadline: string; digest: Hex };
  signer: { scheme: 'bls' | 'ecdsa'; identity: string; proof: Hex };
  amadeus: AnchorResult | null;
  chain: { txHash: Hex; blockNumber: string; status: string; explorerUrl: string } | null;
  status: DecisionStatus;
  error?: string;
}

const MAX_RECORDS = 200;

export class DecisionStore {
  private records: DecisionRecord[] = [];
  readonly events = new EventEmitter();
  private readonly file: string | null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? join(dataDir, 'decisions.json') : null;
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    if (this.file && existsSync(this.file)) {
      this.records = JSON.parse(readFileSync(this.file, 'utf8')) as DecisionRecord[];
    }
  }

  list(): readonly DecisionRecord[] {
    return this.records;
  }

  latest(): DecisionRecord | undefined {
    return this.records[0];
  }

  /** Inserts or replaces (by id) and notifies subscribers. Records are never mutated in place. */
  upsert(record: DecisionRecord): DecisionRecord {
    const others = this.records.filter((r) => r.id !== record.id);
    this.records = [record, ...others].slice(0, MAX_RECORDS);
    this.persist();
    this.events.emit('decision', record);
    return record;
  }

  private persist(): void {
    if (this.file) writeFileSync(this.file, JSON.stringify(this.records, null, 2));
  }
}
