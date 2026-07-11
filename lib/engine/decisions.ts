import { getDB } from './db';
import type { Decision, DecisionRecord } from './types';

/** Legacy entries were bare strings with no timestamp. */
export function normalizeDecision(value: Decision | DecisionRecord): DecisionRecord {
  return typeof value === 'string' ? { v: value, at: 0 } : value;
}

/** Effective decisions for the UI (tombstones filtered out). */
export async function loadDecisions(): Promise<Map<string, Decision>> {
  const map = new Map<string, Decision>();
  for (const [id, rec] of await loadDecisionRecords()) {
    if (rec.v) map.set(id, rec.v);
  }
  return map;
}

/** Raw records including tombstones — what sync exchanges. */
export async function loadDecisionRecords(): Promise<Map<string, DecisionRecord>> {
  const db = await getDB();
  const tx = db.transaction('decisions');
  const [keys, values] = await Promise.all([tx.store.getAllKeys(), tx.store.getAll()]);
  return new Map(keys.map((k, i) => [k, normalizeDecision(values[i])]));
}

/** null writes a tombstone (not a delete) so clearing a decision syncs too. */
export async function saveDecision(id: string, decision: Decision | null): Promise<void> {
  const db = await getDB();
  await db.put('decisions', { v: decision, at: Date.now() }, id);
}
