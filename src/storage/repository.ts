// Storage port. The engine never sees this; only the service layer does.
// Deliberately tiny: a versioned key -> JSON document store with batched reads and
// atomic multi-doc commits. Maps onto Postgres (one JSONB table), SQLite/D1,
// Firestore, DynamoDB, Redis... pick whatever is cheapest.

export type DocKey = `player:${string}` | `base:${string}` | `region:${string}`;

export interface Doc {
  version: number;
}

export interface Write {
  key: DocKey;
  doc: Doc;
  expectedVersion: number; // 0 = must not exist yet
}

export class ConflictError extends Error {}

export interface Repository {
  getMany(keys: readonly DocKey[]): Promise<Map<DocKey, Doc>>;
  /** All-or-nothing. Throws ConflictError if any doc's version moved since it was read. */
  commit(writes: readonly Write[]): Promise<void>;
}

/*
  Postgres / D1 schema sketch:

    CREATE TABLE docs (key TEXT PRIMARY KEY, version INT NOT NULL, data JSONB NOT NULL);

    getMany: SELECT key, version, data FROM docs WHERE key = ANY($1)
    commit:  in a transaction, per write:
               UPDATE docs SET data=$2, version=version+1 WHERE key=$1 AND version=$3
               (or INSERT ... ON CONFLICT DO NOTHING when expectedVersion = 0)
             any 0-row result -> ROLLBACK + ConflictError
*/
