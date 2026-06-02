/**
 * memlight provider.
 *
 * Storage is PGlite (Postgres in WebAssembly) with the pgvector
 * extension, so cosine similarity search runs in-process with no
 * server. By default memlight embeds with a bundled local model and
 * stores under the OS app-data directory, so it works with no config.
 *
 * Recall blends four signals: semantic similarity, keyword overlap,
 * tag overlap, and recency (memories accessed or updated recently rank
 * a little higher). Importance nudges ranking too. Deletes are soft by
 * default and recoverable.
 */

import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { resolveDataDir } from './paths.js'
import { createDefaultEmbedder, DEFAULT_VECTOR_DIM } from './embedder.js'
import {
  DEFAULT_SEARCH_WEIGHTS,
  type MemoryProvider,
  type MemoryProviderConfig,
  type MemoryRecord,
  type MemoryEdge,
  type StoreInput,
  type StoreOptions,
  type StoreResult,
  type UpdateInput,
  type DeleteOptions,
  type DuplicateCheck,
  type RecallQuery,
  type ListFilter,
  type SearchWeights,
  type Embedder,
} from './types.js'

interface MemoryRow {
  id: string
  content: string
  tags: string[]
  importance: number
  type: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  access_count: number
  last_accessed: string | null
  /** pgvector text form ('[1,2,3]') when the column is selected. */
  embedding?: string | null
}

interface EdgeRow {
  id: string
  from_id: string
  to_id: string
  relation: string
  strength: number
  metadata: Record<string, unknown>
  created_at: string
}

const DEFAULT_LIMIT = 20
const DEFAULT_DEDUP_THRESHOLD = 0.9
/** How recency and importance nudge the relevance blend (additive). */
const RECENCY_WEIGHT = 0.15
const IMPORTANCE_WEIGHT = 0.1
/** Recency half-life: a memory this old contributes ~0.37 recency. */
const RECENCY_HALF_LIFE_HOURS = 24 * 30

const MEMORY_COLUMNS = `id, content, tags, importance, type, metadata,
  created_at, updated_at, access_count, last_accessed`

/**
 * Boot and return a memlight {@link MemoryProvider}.
 *
 * Call with no arguments for zero-config defaults: the bundled
 * embedder and OS app-data storage under `memlight/`. See
 * {@link MemoryProviderConfig} for the knobs.
 */
export async function createMemoryProvider(
  config: MemoryProviderConfig = {},
): Promise<MemoryProvider> {
  const embed = resolveEmbedder(config.embedder)
  const vectorDim = config.vectorDim ?? DEFAULT_VECTOR_DIM
  const weights = { ...DEFAULT_SEARCH_WEIGHTS, ...config.weights }
  const dataDir = resolveDataDir(config)

  const pg = await PGlite.create({ dataDir, extensions: { vector } })
  await initSchema(pg, vectorDim)

  return {
    store: (input, options) => storeMemory(pg, embed, vectorDim, input, options),
    recall: (query) => recallMemories(pg, embed, weights, query),
    list: (filter) => listMemories(pg, filter ?? {}),
    get: (id) => getMemory(pg, id),
    update: (id, input) => updateMemory(pg, embed, vectorDim, id, input),
    delete: (id, options) => deleteMemory(pg, id, options),
    restore: (id) => restoreMemory(pg, id),
    checkDuplicate: (content, threshold) =>
      checkDuplicate(pg, embed, content, threshold ?? DEFAULT_DEDUP_THRESHOLD),
    associate: (fromId, toId, relation, strength) =>
      createEdge(pg, fromId, toId, relation, strength ?? 0.5),
    neighbors: (id) => listEdges(pg, id),
    count: () => countMemories(pg),
    export: (format) => exportAll(pg, format),
    import: (data, format) => importAll(pg, embed, vectorDim, data, format),
    close: () => pg.close(),
    _clearForTest: () => clearAllForTest(pg),
  }
}

/** Pick the embedder: a function as-is, 'none' to disable, default otherwise. */
function resolveEmbedder(embedder: MemoryProviderConfig['embedder']): Embedder | undefined {
  if (embedder === 'none') return undefined
  if (typeof embedder === 'function') return embedder
  return createDefaultEmbedder()
}

// ---------------------------------------------------------------------------
// Schema + migrations
// ---------------------------------------------------------------------------

const CURRENT_SCHEMA_VERSION = 2

interface Migration {
  version: number
  description: string
  apply: (pg: PGlite, vectorDim: number) => Promise<void>
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initial schema: memories, memory_edges, indexes',
    apply: async (pg, vectorDim) => {
      await pg.exec(`CREATE EXTENSION IF NOT EXISTS vector;`)
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
      `)
      await pg.exec(`CREATE INDEX IF NOT EXISTS memories_tags_idx ON memories USING GIN (tags);`)
      await pg.exec(`
        CREATE INDEX IF NOT EXISTS memories_embedding_idx
          ON memories USING hnsw (embedding vector_cosine_ops);
      `)
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
      `)
      await pg.exec(`CREATE INDEX IF NOT EXISTS memory_edges_from_idx ON memory_edges (from_id);`)
      await pg.exec(`CREATE INDEX IF NOT EXISTS memory_edges_to_idx   ON memory_edges (to_id);`)
    },
  },
  {
    version: 2,
    description: 'access tracking + soft delete (decay, restore)',
    apply: async (pg) => {
      await pg.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0;`)
      await pg.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMPTZ;`)
      await pg.exec(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`)
      await pg.exec(`CREATE INDEX IF NOT EXISTS memories_deleted_idx ON memories (deleted_at);`)
    },
  },
]

async function initSchema(pg: PGlite, vectorDim: number): Promise<void> {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS memlight_schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      description TEXT NOT NULL
    );
  `)

  const result = await pg.query<{ version: number }>(
    `SELECT COALESCE(MAX(version), 0) AS version FROM memlight_schema_version`,
  )
  const currentVersion = result.rows[0]?.version ?? 0

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue
    await migration.apply(pg, vectorDim)
    await pg.query(
      `INSERT INTO memlight_schema_version (version, description) VALUES ($1, $2)
         ON CONFLICT (version) DO NOTHING`,
      [migration.version, migration.description],
    )
  }

  const highest = Math.max(...MIGRATIONS.map((m) => m.version))
  if (CURRENT_SCHEMA_VERSION !== highest) {
    throw new Error(
      `memlight: CURRENT_SCHEMA_VERSION=${CURRENT_SCHEMA_VERSION} but the highest ` +
        `migration is ${highest}. Add the missing migration or fix the constant.`,
    )
  }
}

/** Read the schema version a dataDir is at. Returns 0 for a fresh one. */
export async function readSchemaVersion(pg: PGlite): Promise<number> {
  try {
    const result = await pg.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) AS version FROM memlight_schema_version`,
    )
    return result.rows[0]?.version ?? 0
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (code === '42P01') return 0
    throw err
  }
}

/** Exposed for tests and diagnostics. */
export const MEMLIGHT_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

async function storeMemory(
  pg: PGlite,
  embed: Embedder | undefined,
  vectorDim: number,
  input: StoreInput,
  options?: StoreOptions,
): Promise<StoreResult> {
  if (!input.content || !input.content.trim()) {
    throw new Error('memlight.store: content is required')
  }

  if (options?.dedup) {
    const dup = await checkDuplicate(
      pg,
      embed,
      input.content,
      options.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD,
    )
    if (dup.isDuplicate && dup.existingId) {
      return { id: dup.existingId, deduped: true }
    }
  }

  const id = input.id ?? randomUUID()
  const embedding = await embedContent(embed, vectorDim, input.content)

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
    baseParams(id, input, embedding),
  )

  return { id }
}

/** Build the INSERT parameter list, with or without the embedding. */
function baseParams(
  id: string,
  input: StoreInput,
  embedding: number[] | null,
): unknown[] {
  const params: unknown[] = [
    id,
    input.content,
    JSON.stringify(input.tags ?? []),
    input.importance ?? 0.5,
    input.type ?? null,
    JSON.stringify(input.metadata ?? {}),
  ]
  if (embedding) params.push(formatVector(embedding))
  return params
}

/** Embed content, validating the dimension. Returns null with no embedder. */
async function embedContent(
  embed: Embedder | undefined,
  vectorDim: number,
  content: string,
): Promise<number[] | null> {
  if (!embed) return null
  const vec = await embed(content)
  if (vec.length === 0) return null
  if (vec.length !== vectorDim) {
    throw new Error(`memlight: embedder returned ${vec.length} dims, expected ${vectorDim}`)
  }
  return vec
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

async function recallMemories(
  pg: PGlite,
  embed: Embedder | undefined,
  weights: SearchWeights,
  q: RecallQuery,
): Promise<MemoryRecord[]> {
  const limit = q.limit ?? DEFAULT_LIMIT
  const minScore = q.minScore ?? 0
  const hasQuery = Boolean(q.query && q.query.trim())
  const queryVec = embed && hasQuery ? await embed(q.query as string) : null

  // No usable query vector: keyword path if there is query text, else newest.
  if (!queryVec || queryVec.length === 0) {
    const rows = await candidateRows(pg, q.tags ?? [])
    if (!hasQuery) {
      return rows.slice(0, limit).map(rowToRecord)
    }
    const ranked = rankRows(rows, q.query as string, q.tags ?? [], { ...weights, semantic: 0 }, null)
    const top = ranked.slice(0, limit)
    await bumpAccess(pg, top.map((r) => r.id))
    return top
  }

  // Vector path: pull a similarity-ordered pool, then blend in JS.
  const pool = Math.max(limit * 4, 50)
  const tagFilter = (q.tags ?? []).length > 0
  const vec = formatVector(queryVec)
  const sql = tagFilter
    ? `SELECT ${MEMORY_COLUMNS}, 1 - (embedding <=> $1::vector) AS score
         FROM memories
         WHERE deleted_at IS NULL AND embedding IS NOT NULL AND tags @> $2::jsonb
         ORDER BY embedding <=> $1::vector LIMIT $3;`
    : `SELECT ${MEMORY_COLUMNS}, 1 - (embedding <=> $1::vector) AS score
         FROM memories
         WHERE deleted_at IS NULL AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector LIMIT $2;`
  const params = tagFilter ? [vec, JSON.stringify(q.tags), pool] : [vec, pool]
  const result = await pg.query<MemoryRow & { score: number }>(sql, params)

  const ranked = rankRows(result.rows, q.query as string, q.tags ?? [], weights, (row) => row.score ?? 0)
    .filter((r) => (r.score ?? 0) >= minScore)
  const top = ranked.slice(0, limit)
  await bumpAccess(pg, top.map((r) => r.id))
  return top
}

/** Fetch live rows, optionally tag-filtered, newest first (the candidate set). */
async function candidateRows(pg: PGlite, tags: string[]): Promise<MemoryRow[]> {
  if (tags.length === 0) {
    const result = await pg.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM memories
         WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500;`,
    )
    return result.rows
  }
  const result = await pg.query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE deleted_at IS NULL AND tags @> $1::jsonb ORDER BY created_at DESC LIMIT 500;`,
    [JSON.stringify(tags)],
  )
  return result.rows
}

/**
 * Blend semantic, keyword, tag, importance, and recency into a final
 * ranking and sort. `semanticOf` returns the cosine score for a row,
 * or null in the keyword-only path.
 */
function rankRows(
  rows: Array<MemoryRow & { score?: number }>,
  query: string,
  queryTags: string[],
  weights: SearchWeights,
  semanticOf: ((row: MemoryRow & { score?: number }) => number) | null,
): MemoryRecord[] {
  const queryTokens = new Set(tokenize(query))
  const active =
    weights.semantic * (semanticOf ? 1 : 0) +
    weights.keyword * (queryTokens.size > 0 ? 1 : 0) +
    weights.tag * (queryTags.length > 0 ? 1 : 0)
  const norm = active > 0 ? active : 1

  const scored = rows.map((row) => {
    const semantic = semanticOf ? semanticOf(row) : 0
    const keyword = keywordScore(queryTokens, row.content)
    const tag = queryTags.length > 0 ? tagOverlap(queryTags, row.tags) : 0
    const relevance =
      (weights.semantic * (semanticOf ? semantic : 0) +
        weights.keyword * keyword +
        weights.tag * tag) /
      norm
    const rank =
      relevance +
      RECENCY_WEIGHT * recencyScore(row) +
      IMPORTANCE_WEIGHT * row.importance
    const record = rowToRecord(row)
    record.score = semanticOf ? semantic : keyword
    return { record, rank }
  })

  scored.sort((a, b) => b.rank - a.rank)
  return scored.map((s) => s.record)
}

/** Increment access_count and stamp last_accessed for the returned ids. */
async function bumpAccess(pg: PGlite, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await pg.query(
    `UPDATE memories SET access_count = access_count + 1, last_accessed = now()
       WHERE id = ANY($1::text[]);`,
    [ids],
  )
}

// ---------------------------------------------------------------------------
// List (structured query)
// ---------------------------------------------------------------------------

const LIST_SORT_COLUMNS: Record<NonNullable<ListFilter['sortBy']>, string> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  importance: 'importance',
  accessCount: 'access_count',
  lastAccessed: 'last_accessed',
}

async function listMemories(pg: PGlite, filter: ListFilter): Promise<MemoryRecord[]> {
  const where: string[] = []
  const params: unknown[] = []
  let n = 1

  if (!filter.includeDeleted) where.push('deleted_at IS NULL')
  if (filter.type !== undefined) {
    where.push(`type = $${n++}`)
    params.push(filter.type)
  }
  if (filter.minImportance !== undefined) {
    where.push(`importance >= $${n++}`)
    params.push(filter.minImportance)
  }
  if (filter.maxImportance !== undefined) {
    where.push(`importance <= $${n++}`)
    params.push(filter.maxImportance)
  }
  if (filter.createdAfter !== undefined) {
    where.push(`created_at >= $${n++}`)
    params.push(filter.createdAfter)
  }
  if (filter.createdBefore !== undefined) {
    where.push(`created_at <= $${n++}`)
    params.push(filter.createdBefore)
  }
  if (filter.tags && filter.tags.length > 0) {
    if ((filter.tagMatch ?? 'all') === 'any') {
      where.push(`tags ?| $${n++}::text[]`)
      params.push(filter.tags)
    } else {
      where.push(`tags @> $${n++}::jsonb`)
      params.push(JSON.stringify(filter.tags))
    }
  }

  const sortCol = LIST_SORT_COLUMNS[filter.sortBy ?? 'createdAt']
  const dir = (filter.sortDirection ?? 'desc') === 'asc' ? 'ASC' : 'DESC'
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  let sql = `SELECT ${MEMORY_COLUMNS}, embedding FROM memories ${whereSql}
    ORDER BY ${sortCol} ${dir} NULLS LAST`
  if (filter.limit !== undefined) {
    sql += ` LIMIT $${n++}`
    params.push(filter.limit)
  }
  if (filter.offset !== undefined) {
    sql += ` OFFSET $${n++}`
    params.push(filter.offset)
  }

  const result = await pg.query<MemoryRow>(sql, params)
  return result.rows.map(rowToRecord)
}

// ---------------------------------------------------------------------------
// Read / update / delete / restore / count
// ---------------------------------------------------------------------------

async function getMemory(pg: PGlite, id: string): Promise<MemoryRecord | null> {
  const result = await pg.query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS}, embedding FROM memories WHERE id = $1 AND deleted_at IS NULL;`,
    [id],
  )
  return result.rows[0] ? rowToRecord(result.rows[0]) : null
}

async function updateMemory(
  pg: PGlite,
  embed: Embedder | undefined,
  vectorDim: number,
  id: string,
  input: UpdateInput,
): Promise<MemoryRecord | null> {
  const existing = await getMemory(pg, id)
  if (!existing) return null

  const merged = {
    content: input.content ?? existing.content,
    tags: input.tags ?? existing.tags,
    importance: input.importance ?? existing.importance,
    type: input.type ?? existing.type,
    metadata: input.metadata ?? existing.metadata,
  }
  const contentChanged = input.content !== undefined && input.content !== existing.content
  const embedding = contentChanged ? await embedContent(embed, vectorDim, merged.content) : undefined

  await pg.query(
    `UPDATE memories SET
       content = $2, tags = $3::jsonb, importance = $4, type = $5, metadata = $6::jsonb,
       ${embedding ? 'embedding = $7::vector,' : ''}
       updated_at = now()
     WHERE id = $1;`,
    embedding
      ? [id, merged.content, JSON.stringify(merged.tags), merged.importance, merged.type,
         JSON.stringify(merged.metadata), formatVector(embedding)]
      : [id, merged.content, JSON.stringify(merged.tags), merged.importance, merged.type,
         JSON.stringify(merged.metadata)],
  )
  return getMemory(pg, id)
}

async function deleteMemory(pg: PGlite, id: string, options?: DeleteOptions): Promise<boolean> {
  if (options?.hard) {
    const result = await pg.query(`DELETE FROM memories WHERE id = $1 RETURNING id;`, [id])
    return result.rows.length > 0
  }
  const result = await pg.query(
    `UPDATE memories SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id;`,
    [id],
  )
  return result.rows.length > 0
}

async function restoreMemory(pg: PGlite, id: string): Promise<boolean> {
  const result = await pg.query(
    `UPDATE memories SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id;`,
    [id],
  )
  return result.rows.length > 0
}

async function countMemories(pg: PGlite): Promise<number> {
  const result = await pg.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM memories WHERE deleted_at IS NULL;`,
  )
  return parseInt(result.rows[0]?.count ?? '0', 10)
}

async function clearAllForTest(pg: PGlite): Promise<void> {
  await pg.query('DELETE FROM memory_edges;')
  await pg.query('DELETE FROM memories;')
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

async function checkDuplicate(
  pg: PGlite,
  embed: Embedder | undefined,
  content: string,
  threshold: number,
): Promise<DuplicateCheck> {
  if (!embed || !content.trim()) return { isDuplicate: false }
  const vec = await embed(content)
  if (vec.length === 0) return { isDuplicate: false }

  const result = await pg.query<{ id: string; score: number }>(
    `SELECT id, 1 - (embedding <=> $1::vector) AS score
       FROM memories
       WHERE deleted_at IS NULL AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector LIMIT 1;`,
    [formatVector(vec)],
  )
  const top = result.rows[0]
  if (top && top.score >= threshold) {
    return { isDuplicate: true, existingId: top.id, score: top.score }
  }
  return top ? { isDuplicate: false, score: top.score } : { isDuplicate: false }
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

interface ExportedMemory {
  kind: 'memory'
  id: string
  content: string
  tags: string[]
  importance: number
  type: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

interface ExportedEdge {
  kind: 'edge'
  id: string
  fromId: string
  toId: string
  relation: string
  strength: number
  metadata: Record<string, unknown>
}

async function exportAll(pg: PGlite, format: 'jsonl' = 'jsonl'): Promise<string> {
  if (format !== 'jsonl') throw new Error(`memlight.export: unsupported format ${format}`)
  const memories = await pg.query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memories WHERE deleted_at IS NULL ORDER BY created_at;`,
  )
  const edges = await pg.query<EdgeRow>(
    `SELECT id, from_id, to_id, relation, strength, metadata, created_at FROM memory_edges ORDER BY created_at;`,
  )
  const lines: string[] = []
  for (const row of memories.rows) {
    const line: ExportedMemory = {
      kind: 'memory',
      id: row.id,
      content: row.content,
      tags: row.tags,
      importance: row.importance,
      type: row.type,
      metadata: row.metadata,
      createdAt: normalizeTimestamp(row.created_at),
    }
    lines.push(JSON.stringify(line))
  }
  for (const row of edges.rows) {
    const line: ExportedEdge = {
      kind: 'edge',
      id: row.id,
      fromId: row.from_id,
      toId: row.to_id,
      relation: row.relation,
      strength: row.strength,
      metadata: row.metadata,
    }
    lines.push(JSON.stringify(line))
  }
  return lines.join('\n')
}

async function importAll(
  pg: PGlite,
  embed: Embedder | undefined,
  vectorDim: number,
  data: string,
  format: 'jsonl' = 'jsonl',
): Promise<{ imported: number }> {
  if (format !== 'jsonl') throw new Error(`memlight.import: unsupported format ${format}`)
  let imported = 0
  for (const raw of data.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const record = JSON.parse(line) as ExportedMemory | ExportedEdge
    if (record.kind === 'memory') {
      const embedding = await embedContent(embed, vectorDim, record.content)
      await pg.query(
        `INSERT INTO memories (id, content, tags, importance, type, metadata, embedding, created_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, ${embedding ? '$8::vector' : 'NULL'}, $7)
         ON CONFLICT (id) DO NOTHING;`,
        embedding
          ? [record.id, record.content, JSON.stringify(record.tags), record.importance,
             record.type, JSON.stringify(record.metadata), record.createdAt, formatVector(embedding)]
          : [record.id, record.content, JSON.stringify(record.tags), record.importance,
             record.type, JSON.stringify(record.metadata), record.createdAt],
      )
      imported += 1
    } else if (record.kind === 'edge') {
      await pg.query(
        `INSERT INTO memory_edges (id, from_id, to_id, relation, strength, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (id) DO NOTHING;`,
        [record.id, record.fromId, record.toId, record.relation, record.strength,
         JSON.stringify(record.metadata)],
      )
      imported += 1
    }
  }
  return { imported }
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
  const id = randomUUID()
  const result = await pg.query<EdgeRow>(
    `INSERT INTO memory_edges (id, from_id, to_id, relation, strength, metadata)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)
     RETURNING id, from_id, to_id, relation, strength, metadata, created_at;`,
    [id, fromId, toId, relation, strength],
  )
  const row = result.rows[0]
  if (!row) throw new Error(`memlight.associate: failed to create edge ${id}`)
  return edgeRowToEdge(row)
}

async function listEdges(pg: PGlite, id: string): Promise<MemoryEdge[]> {
  const result = await pg.query<EdgeRow>(
    `SELECT id, from_id, to_id, relation, strength, metadata, created_at
       FROM memory_edges WHERE from_id = $1 OR to_id = $1 ORDER BY created_at DESC;`,
    [id],
  )
  return result.rows.map(edgeRowToEdge)
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
    accessCount: row.access_count ?? 0,
    lastAccessed: row.last_accessed ? normalizeTimestamp(row.last_accessed) : null,
  }
  if (row.score !== undefined) record.score = row.score
  if (typeof row.embedding === 'string' && row.embedding.length > 0) {
    record.embedding = JSON.parse(row.embedding) as number[]
  }
  return record
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
  }
}

function normalizeTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** Lowercase alphanumeric tokens, for keyword overlap scoring. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** Fraction of query tokens present in the content, 0..1. */
function keywordScore(queryTokens: Set<string>, content: string): number {
  if (queryTokens.size === 0) return 0
  const contentTokens = new Set(tokenize(content))
  let hits = 0
  for (const token of queryTokens) {
    if (contentTokens.has(token)) hits += 1
  }
  return hits / queryTokens.size
}

/** Fraction of query tags present on the memory, 0..1. */
function tagOverlap(queryTags: string[], memoryTags: string[]): number {
  if (queryTags.length === 0) return 0
  const set = new Set(memoryTags)
  let hits = 0
  for (const tag of queryTags) {
    if (set.has(tag)) hits += 1
  }
  return hits / queryTags.length
}

/** Recency in 0..1 from the most recent of last_accessed / updated_at / created_at. */
function recencyScore(row: MemoryRow): number {
  const stamps = [row.last_accessed, row.updated_at, row.created_at]
    .filter((s): s is string => Boolean(s))
    .map((s) => new Date(s).getTime())
  const newest = stamps.length > 0 ? Math.max(...stamps) : Date.now()
  const ageHours = Math.max(0, Date.now() - newest) / 3_600_000
  return Math.exp(-ageHours / RECENCY_HALF_LIFE_HOURS)
}

/** pgvector literal, e.g. `[1,2,3]`. */
function formatVector(vec: number[]): string {
  return `[${vec.join(',')}]`
}
