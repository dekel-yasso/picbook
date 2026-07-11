import { getDB } from './db';
import type { Decision } from './types';

export async function loadDecisions(): Promise<Map<string, Decision>> {
  const db = await getDB();
  const tx = db.transaction('decisions');
  const [keys, values] = await Promise.all([tx.store.getAllKeys(), tx.store.getAll()]);
  return new Map(keys.map((k, i) => [k, values[i]]));
}

export async function saveDecision(id: string, decision: Decision | null): Promise<void> {
  const db = await getDB();
  if (decision) await db.put('decisions', decision, id);
  else await db.delete('decisions', id);
}
