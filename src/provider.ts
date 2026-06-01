/**
 * memlight — embedded vector memory for Akemi.
 *
 * Architecture:
 *   - Storage: PGlite (Postgres-in-WASM) with the pgvector extension.
 *   - Embeddings: pluggable Embedder function the caller supplies.
 *   - Graph: a simple edges table (memory_edges) for 1-hop lookups.
 *     Deep traversal + consolidation come in v0.2.
 *
 * Why PGlite + pgvector over SQLite + FTS5:
 *   Matt's AutoMem (Python) is the gold standard — Qdrant vector +
 *   FalkorDB graph + multi-provider embeddings. memlight is the
 *   embedded TypeScript equivalent that both Akemi and any future
 *   standalone tool can depend on. PGlite+pgvector gives us real
 *   cosine similarity search in-process without running Qdrant.
 *
 * v0.1 scope:
 *   - vector store + cosine recall
 *   - tag scoping (prefix match, AND semantics)
 *   - edges (1-hop lookup)
 *   - tag-only fallback when no embedder is provided
 *
 * v0.2+: consolidation, multi-hop, hybrid rank, decay.
 */

import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type {
  MemoryProvider,
  MemoryProviderConfig,
  MemoryRecord,
  MemoryEdge,
  StoreInput,
  RecallQuery,
  Embedder,
} from './types.js';

interface MemoryRow {
  id: string;
  content: string;
  tags: string[];
  importance: number;
  type: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  relation: string;
  strength: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

const DEFAULT_VECTOR_DIM = 384;
const DEFAULT_LIMIT = 20;

/**
 * Boot and return a memlight {@link MemoryProvider}.
 *
 * @param config - Boot config; see {@link MemoryProviderConfig}.
 *   `dataDir` is required and must exist on disk. `embed` is
 *   optional but required for vector recall. `vectorDim` defaults to
 *   384 and is locked at the first `store()` call.
 * @returns A live `MemoryProvider` bound to a PGlite instance.
 *
 * @remarks
 * **Side effect:** opens a PGlite instance at `config.dataDir`,
 * loads the pgvector extension, and runs schema migrations to
 * `CURRENT_SCHEMA_VERSION`. Subsequent boots against the same
 * dataDir reuse existing schema and apply only new migrations.
 *
 * **Idempotency:** the migration runner is idempotent on the same
 * dataDir; concurrent boots against the same dataDir are NOT
 * supported (PGlite single-writer constraint).
 *
 * **Transactional context:** none at provider boot; per-operation
 * methods on the returned provider are auto-commit Postgres
 * statements.
 *
 * **Error semantics:** migration failures, dim mismatches, or PGlite
 * boot failures propagate. The provider is unusable on failure; the
 * caller should not retry without diagnosing.
 */
export async function createMemoryProvider(
  config: MemoryProviderConfig,
): Promise<MemoryProvider> {
  const vectorDim = config.vectorDim ?? DEFAULT_VECTOR_DIM;
  const embed: Embedder | undefined = config.embed;

  const pg = await PGlite.create({
    dataDir: config.dataDir,
    extensions: { vector },
  });

  await initSchema(pg, vectorDim);

  return {
    store: (input) => storeMemory(pg, embed, vectorDim, input),
    recall: (query) => recallMemories(pg, embed, query),
    get: (id) => getMemory(pg, id),
    delete: (id) => deleteMemory(pg, id),
    associate: (fromId, toId, relation, strength) =>
      createEdge(pg, fromId, toId, relation, strength ?? 0.5),
    neighbors: (id) => listEdges(pg, id),
    count: () => countMemories(pg),
    close: () => pg.close(),
    // Test-only: empties memories + memory_edges so a single provider
    // can be reused across many tests in one file (saves PGlite cold
    // starts). Production callers should never invoke this — the
    // underscore prefix and `__test__` in the type marker make that
    // intent obvious in code review.
    _clearForTest: () => clearAllForTest(pg),
  };
}

// ---------------------------------------------------------------------------
// Schema + migrations
// ---------------------------------------------------------------------------

/**
 * Current schema version. Bump this and add a new entry to MIGRATIONS
 * whenever the schema changes. The runner records the applied version
 * in the `memlight_schema_version` table so existing dataDirs can
 * upgrade in place without losing data.
 *
 * Versioning rule: every migration is forward-only. Downgrades are
 * not supported — if a user wants to roll back they should restore
 * from a `pg_dump`. v0.1 ships with one entry (the initial schema);
 * v0.2 will append.
 */
const CURRENT_SCHEMA_VERSION = 1;

interface Migration {
  version: number;
  description: string;
  apply: (pg: PGlite, vectorDim: number) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initial schema — memories + memory_edges + indexes',
    apply: async (pg, vectorDim) => {
      await pg.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);
      await pg.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          tags JSONB NOT NULL DEFAULT '[]',
          importance REAL NOT NULL DEFAULT 0.5,
          type TEXT,
          metadata JSONB NOT NULL DEFAULT '{}',
          embedding vector(${vectorDim}),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pg.exec(
        `CREATE INDEX IF NOT EXISTS memories_tags_idx ON memories USING GIN (tags);`,
      );
      // pgvector HNSW index for cosine similarity. PGlite builds it
      // lazily on first vector query; at personal-scale volumes (tens
      // of thousands of memories) a sequential scan is also fine.
      await pg.exec(`
        CREATE INDEX IF NOT EXISTS memories_embedding_idx
          ON memories USING hnsw (embedding vector_cosine_ops);
      `);
      await pg.exec(`
        CREATE TABLE IF NOT EXISTS memory_edges (
          id TEXT PRIMARY KEY,
          from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          to_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          relation TEXT NOT NULL,
          strength REAL NOT NULL DEFAULT 0.5,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pg.exec(`CREATE INDEX IF NOT EXISTS memory_edges_from_idx ON memory_edges (from_id);`);
      await pg.exec(`CREATE INDEX IF NOT EXISTS memory_edges_to_idx   ON memory_edges (to_id);`);
    },
  },
];

/**
 * Migration runner. Idempotent — safe to call on every provider boot.
 *
 * Reads the highest version recorded in `memlight_schema_version`,
 * runs every migration whose version is higher, then records the
 * new high-water mark. A fresh dataDir starts at version 0 and runs
 * everything; an existing dataDir at version N runs only N+1 onward.
 *
 * The version table is created with INSERT IGNORE semantics so
 * concurrent boots can't double-record (though concurrent boots
 * against the same PGlite dataDir are unsupported anyway — see
 * README "Limitations").
 */
async function initSchema(pg: PGlite, vectorDim: number): Promise<void> {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS memlight_schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      description TEXT NOT NULL
    );
  `);

  const result = await pg.query<{ version: number }>(
    `SELECT COALESCE(MAX(version), 0) AS version FROM memlight_schema_version`,
  );
  const currentVersion = result.rows[0]?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    await migration.apply(pg, vectorDim);
    await pg.query(
      `INSERT INTO memlight_schema_version (version, description) VALUES ($1, $2)
         ON CONFLICT (version) DO NOTHING`,
      [migration.version, migration.description],
    );
  }

  // Sanity check — if MIGRATIONS is somehow shorter than CURRENT_SCHEMA_VERSION
  // (i.e. someone bumped the constant without adding a migration),
  // fail loud. This catches the most common schema-evolution mistake.
  if (CURRENT_SCHEMA_VERSION !== Math.max(...MIGRATIONS.map((m) => m.version))) {
    throw new Error(
      `memlight: CURRENT_SCHEMA_VERSION=${CURRENT_SCHEMA_VERSION} but the highest ` +
        `migration is ${Math.max(...MIGRATIONS.map((m) => m.version))}. ` +
        `Add the missing migration or fix the constant.`,
    );
  }
}

/**
 * Read the schema version a dataDir is currently at. Public so
 * tests + tooling can verify the migration runner without poking
 * raw SQL. Returns 0 for a fresh dataDir.
 */
export async function readSchemaVersion(pg: PGlite): Promise<number> {
  try {
    const result = await pg.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) AS version FROM memlight_schema_version`,
    );
    return result.rows[0]?.version ?? 0;
  } catch (err) {
    // Distinguish "relation does not exist" (Postgres error code
    // 42P01 — fresh database, pre-migration-runner) from real errors
    // like permission denied or a malformed table. The relation-
    // doesn't-exist case is the legitimate zero-version path; any
    // other error means the runner can't safely assume zero, so
    // surface it instead of silently re-running every migration.
    // Audit 2026-04-22 LOW #18.
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') {
      return 0;
    }
    throw err;
  }
}

/** Exposed for tests + diagnostics. */
export const MEMLIGHT_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

async function storeMemory(
  pg: PGlite,
  embed: Embedder | undefined,
  vectorDim: number,
  input: StoreInput,
): Promise<{ id: string }> {
  if (!input.content || !input.content.trim()) {
    throw new Error('memlight.store: content is required');
  }
  const id = input.id ?? randomUUID();

  let embedding: number[] | null = null;
  if (embed) {
    const vec = await embed(input.content);
    if (vec.length > 0) {
      if (vec.length !== vectorDim) {
        throw new Error(
          `memlight.store: embedder returned ${vec.length} dims, expected ${vectorDim}`,
        );
      }
      embedding = vec;
    }
  }

  await pg.query(
    `INSERT INTO memories (id, content, tags, importance, type, metadata, embedding)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, ${embedding ? '$7::vector' : 'NULL'})
     ON CONFLICT (id) DO UPDATE SET
       content = EXCLUDED.content,
       tags = EXCLUDED.tags,
       importance = EXCLUDED.importance,
       type = EXCLUDED.type,
       metadata = EXCLUDED.metadata,
       embedding = EXCLUDED.embedding,
       updated_at = now();`,
    embedding
      ? [
          id,
          input.content,
          JSON.stringify(input.tags ?? []),
          input.importance ?? 0.5,
          input.type ?? null,
          JSON.stringify(input.metadata ?? {}),
          formatVector(embedding),
        ]
      : [
          id,
          input.content,
          JSON.stringify(input.tags ?? []),
          input.importance ?? 0.5,
          input.type ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
  );

  return { id };
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

async function recallMemories(
  pg: PGlite,
  embed: Embedder | undefined,
  q: RecallQuery,
): Promise<MemoryRecord[]> {
  const limit = q.limit ?? DEFAULT_LIMIT;
  const minScore = q.minScore ?? 0;
  const tagFilter = (q.tags ?? []).length > 0;

  // Vector path — embedder + query text + similarity ranking.
  if (embed && q.query && q.query.trim()) {
    const queryVec = await embed(q.query);
    if (queryVec.length === 0) {
      return tagOnlyRecall(pg, q.tags ?? [], limit);
    }
    const vec = formatVector(queryVec);

    // Cosine similarity via pgvector: `1 - (a <=> b)` maps
    // distance → similarity in [0,1] (assuming unit-norm vectors
    // — true for most embedders).
    const sql = tagFilter
      ? `SELECT id, content, tags, importance, type, metadata,
                created_at, updated_at,
                1 - (embedding <=> $1::vector) AS score
           FROM memories
           WHERE embedding IS NOT NULL
             AND tags @> $2::jsonb
             AND 1 - (embedding <=> $1::vector) >= $3
           ORDER BY embedding <=> $1::vector
           LIMIT $4;`
      : `SELECT id, content, tags, importance, type, metadata,
                created_at, updated_at,
                1 - (embedding <=> $1::vector) AS score
           FROM memories
           WHERE embedding IS NOT NULL
             AND 1 - (embedding <=> $1::vector) >= $2
           ORDER BY embedding <=> $1::vector
           LIMIT $3;`;

    const params = tagFilter
      ? [vec, JSON.stringify(q.tags), minScore, limit]
      : [vec, minScore, limit];

    const result = await pg.query<MemoryRow & { score: number }>(sql, params);
    return result.rows.map(rowToRecord);
  }

  // No embedder or no query — tag-only path.
  return tagOnlyRecall(pg, q.tags ?? [], limit);
}

async function tagOnlyRecall(
  pg: PGlite,
  tags: string[],
  limit: number,
): Promise<MemoryRecord[]> {
  if (tags.length === 0) {
    const result = await pg.query<MemoryRow>(
      `SELECT id, content, tags, importance, type, metadata,
              created_at, updated_at
         FROM memories
         ORDER BY created_at DESC
         LIMIT $1;`,
      [limit],
    );
    return result.rows.map(rowToRecord);
  }
  const result = await pg.query<MemoryRow>(
    `SELECT id, content, tags, importance, type, metadata,
            created_at, updated_at
       FROM memories
       WHERE tags @> $1::jsonb
       ORDER BY created_at DESC
       LIMIT $2;`,
    [JSON.stringify(tags), limit],
  );
  return result.rows.map(rowToRecord);
}

// ---------------------------------------------------------------------------
// Read / delete / count
// ---------------------------------------------------------------------------

async function getMemory(pg: PGlite, id: string): Promise<MemoryRecord | null> {
  const result = await pg.query<MemoryRow>(
    `SELECT id, content, tags, importance, type, metadata, created_at, updated_at
       FROM memories WHERE id = $1;`,
    [id],
  );
  return result.rows[0] ? rowToRecord(result.rows[0]) : null;
}

async function deleteMemory(pg: PGlite, id: string): Promise<boolean> {
  const result = await pg.query(
    `DELETE FROM memories WHERE id = $1 RETURNING id;`,
    [id],
  );
  return result.rows.length > 0;
}

async function countMemories(pg: PGlite): Promise<number> {
  const result = await pg.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM memories;`,
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

async function clearAllForTest(pg: PGlite): Promise<void> {
  // ON DELETE CASCADE on memory_edges.from_id / to_id removes the
  // edges automatically, but we truncate explicitly to be obvious
  // about what this empties.
  await pg.query('DELETE FROM memory_edges;');
  await pg.query('DELETE FROM memories;');
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

async function createEdge(
  pg: PGlite,
  fromId: string,
  toId: string,
  relation: string,
  strength: number,
): Promise<MemoryEdge> {
  const id = randomUUID();
  const result = await pg.query<EdgeRow>(
    `INSERT INTO memory_edges (id, from_id, to_id, relation, strength, metadata)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)
     RETURNING id, from_id, to_id, relation, strength, metadata, created_at;`,
    [id, fromId, toId, relation, strength],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`memlight.associate: failed to create edge ${id}`);
  return edgeRowToEdge(row);
}

async function listEdges(pg: PGlite, id: string): Promise<MemoryEdge[]> {
  const result = await pg.query<EdgeRow>(
    `SELECT id, from_id, to_id, relation, strength, metadata, created_at
       FROM memory_edges
       WHERE from_id = $1 OR to_id = $1
       ORDER BY created_at DESC;`,
    [id],
  );
  return result.rows.map(edgeRowToEdge);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRecord(row: MemoryRow & { score?: number }): MemoryRecord {
  const record: MemoryRecord = {
    id: row.id,
    content: row.content,
    tags: row.tags,
    importance: row.importance,
    type: row.type,
    metadata: row.metadata,
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
  };
  if (row.score !== undefined) record.score = row.score;
  return record;
}

function edgeRowToEdge(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation,
    strength: row.strength,
    metadata: row.metadata,
    createdAt: normalizeTimestamp(row.created_at),
  };
}

function normalizeTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** pgvector literal — `[1.0,2.0,3.0]`. */
function formatVector(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
