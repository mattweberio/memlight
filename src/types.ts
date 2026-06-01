/**
 * Public types for memlight.
 *
 * memlight is vector-first memory. Every stored memory has an
 * embedding (generated at store-time via a pluggable Embedder);
 * recall is cosine similarity over pgvector. Tag scoping is
 * layered on top, not a replacement for vector search.
 */

/** A single stored memory. */
export interface MemoryRecord {
  id: string;
  content: string;
  tags: string[];
  importance: number;
  /** Optional short label: Decision | Insight | Context | Preference |
   *  Pattern | etc. Free-form; memlight doesn't enumerate. */
  type: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Present only on recall results. Cosine similarity 0..1 where
   *  1.0 is an exact match. Higher is better. */
  score?: number;
}

/**
 * Input to {@link MemoryProvider.store}.
 *
 * @remarks
 * `content` is required and must be non-empty after trim — empty
 * content throws. `id` is optional; an absent id triggers UUIDv4
 * generation. `tags` is an unordered set; recall matching is AND
 * semantics across the tag array. `importance` is `[0, 1]` — stored
 * for future decay logic; ignored by v0.1 ranking. `metadata` is
 * caller-controlled opaque JSON.
 */
export interface StoreInput {
  /** Caller-supplied id. If omitted, memlight generates a UUIDv4. */
  id?: string;
  content: string;
  tags?: string[];
  /** 0..1 subjective importance. Stored for future decay strategies;
   *  does not affect recall ranking in v0.1. */
  importance?: number;
  type?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Query shape for {@link MemoryProvider.recall}.
 *
 * @remarks
 * Two recall paths:
 *
 * - **Vector path** — when an embedder is configured AND `query` is
 *   set, recall embeds the query and ranks by cosine similarity.
 *   `tags` (if set) is an AND filter applied before ranking.
 *   `minScore` is the lower similarity threshold.
 *
 * - **Tag-only path** — when no embedder is configured OR `query` is
 *   absent, recall ignores similarity and returns the newest rows
 *   matching `tags` (or the newest rows overall if `tags` is empty).
 *
 * `limit` defaults to 20; `minScore` defaults to 0.
 */
export interface RecallQuery {
  /** Natural-language query. memlight embeds it and searches by
   *  cosine similarity. Required unless `tags` alone is enough. */
  query?: string;
  /** Only return memories that have ALL of these tags. */
  tags?: string[];
  /** Upper bound on returned records. Default 20. */
  limit?: number;
  /** Minimum similarity score 0..1. Memories below this are filtered
   *  out. Default 0 (no threshold). */
  minScore?: number;
}

/** One edge in the memory graph. Matches the AutoMem v1 edge model
 *  (shallow — relation, strength, metadata). Full graph traversal is
 *  a v0.2 deliverable; v0.1 ships CRUD + 1-hop lookup. */
export interface MemoryEdge {
  id: string;
  fromId: string;
  toId: string;
  relation: string;
  strength: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * Pluggable async embedder. The host app supplies this at provider
 * creation time. memlight calls it in `store()` to vectorize content
 * and in `recall()` to vectorize the query.
 *
 * The returned array length must be consistent across calls from
 * the same embedder — memlight fixes the `memories.embedding`
 * column dimension at the first `store()` call based on this.
 *
 * If the host app doesn't want vector search at all (e.g. for a
 * local dev smoke test), it can return a zero-length array —
 * memlight will detect that and fall back to tag-only recall.
 */
export type Embedder = (text: string) => Promise<number[]>;

/**
 * Boot-time configuration for {@link createMemoryProvider}.
 *
 * @remarks
 * `dataDir` is the only required field — memlight does NOT create
 * the directory; the host must `mkdir -p` first. `embed` is optional:
 * when absent, recall falls back to tag-only matching. `vectorDim`
 * is locked at the first `store()` call (the `memories.embedding`
 * column type fixes it); changing it later means starting from a
 * fresh dataDir.
 */
export interface MemoryProviderConfig {
  /** Absolute path to the pglite data directory. Must be writable.
   *  memlight does NOT mkdir — the host chooses where data lives. */
  dataDir: string;
  /** Pluggable embedder. Required for vector recall; if absent,
   *  recall falls back to tag filtering only. */
  embed?: Embedder;
  /** Vector dimension. Must match the embedder output shape. Default
   *  is 384 (matches the common all-MiniLM-L6-v2 model). Cannot be
   *  changed after the first store() — the column type is fixed on
   *  the first insert. */
  vectorDim?: number;
}

/** The main memlight API. Matches the shape of v1 AutoMemClient
 *  where semantically equivalent, diverging only where AutoMem's
 *  HTTP interface would be awkward in-process. */
export interface MemoryProvider {
  store(input: StoreInput): Promise<{ id: string }>;
  recall(query: RecallQuery): Promise<MemoryRecord[]>;
  get(id: string): Promise<MemoryRecord | null>;
  delete(id: string): Promise<boolean>;
  associate(fromId: string, toId: string, relation: string, strength?: number): Promise<MemoryEdge>;
  neighbors(id: string): Promise<MemoryEdge[]>;
  count(): Promise<number>;
  close(): Promise<void>;
  /** Test-only: truncates `memories` + `memory_edges` so a single
   *  provider can be reused across many tests in one file without
   *  paying the ~3.5s PGlite cold-start per case. Never call from
   *  production code — the underscore prefix marks the intent. */
  _clearForTest(): Promise<void>;
}
