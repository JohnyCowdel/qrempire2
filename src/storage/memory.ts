import { ConflictError, type Doc, type DocKey, type Repository, type Write } from './repository.ts';

/** In-memory adapter for simulation and tests. Counts operations so you can estimate DB cost. */
export class MemoryRepository implements Repository {
  readonly docs = new Map<DocKey, string>();
  readonly stats = { readCalls: 0, docsRead: 0, commits: 0, docsWritten: 0, conflicts: 0 };

  async getMany(keys: readonly DocKey[]): Promise<Map<DocKey, Doc>> {
    this.stats.readCalls++;
    const out = new Map<DocKey, Doc>();
    for (const k of keys) {
      const raw = this.docs.get(k);
      if (raw) out.set(k, JSON.parse(raw));
    }
    this.stats.docsRead += keys.length;
    return out;
  }

  async commit(writes: readonly Write[]): Promise<void> {
    for (const w of writes) {
      const raw = this.docs.get(w.key);
      const current = raw ? (JSON.parse(raw) as Doc).version : 0;
      if (current !== w.expectedVersion) {
        this.stats.conflicts++;
        throw new ConflictError(w.key);
      }
    }
    for (const w of writes) this.docs.set(w.key, JSON.stringify(w.doc));
    this.stats.commits++;
    this.stats.docsWritten += writes.length;
  }
}
