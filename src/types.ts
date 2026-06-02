/**
 * Public types for memlight.
 *
 * memlight is vector-first memory. A stored memory carries an
 * embedding (generated at store time by the bundled default embedder
 * or one you supply), and recall ranks by a blend of semantic
 * similarity, keyword overlap, tag overlap, and recency. Tags scope
 * and filter; they do not replace vector search.
 */

/** A single stored memory. */
export interface MemoryRecord {
  id: string
  content: string
  tags: string[]
  importance: number
  /** Optional short label such as Decision, Insight, Preference. Free-form. */
  type: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  /** How many times this memory has been returned by recall. */
  accessCount: number
  /** ISO timestamp of the last recall that returned it, or null. */
  lastAccessed: string | null
  /** Present only on recall results. Cosine similarity 0..1, higher is better. */
  score?: number
  /** The stored embedding vector. Populated by get() and list(); omitted from
   *  recall results to keep them lean, and absent when no embedder was used. */
  embedding?: number[]
}

/**
 * Input to {@link MemoryProvider.store}.
 *
 * `content` is required and must be non-empty after trimming. `id` is
 * optional and triggers a generated UUID when omitted (pass an id to
 * upsert). `tags` is an unordered set used for scoping and recall
 * filtering. `importance` is 0..1 and feeds recall ranking. `metadata`
 * is opaque caller-owned JSON.
 */
export interface StoreInput {
  id?: string
  content: string
  tags?: string[]
  importance?: number
  type?: string
  metadata?: Record<string, unknown>
}

/** Fields you can change with {@link MemoryProvider.update}. All optional. */
export interface UpdateInput {
  content?: string
  tags?: string[]
  importance?: number
  type?: string
  metadata?: Record<string, unknown>
}

/** Options for {@link MemoryProvider.store}. */
export interface StoreOptions {
  /** Skip the insert and return the existing memory if a near-duplicate
   *  already exists (cosine similarity at or above the threshold). */
  dedup?: boolean
  /** Similarity threshold for `dedup`. Default 0.9. */
  dedupThreshold?: number
}

/** Result of {@link MemoryProvider.store}. */
export interface StoreResult {
  id: string
  /** True when `dedup` matched an existing memory and no new row was written. */
  deduped?: boolean
}

/** Options for {@link MemoryProvider.delete}. */
export interface DeleteOptions {
  /** Permanently remove the row instead of soft-deleting it. Default false. */
  hard?: boolean
}

/** Result of {@link MemoryProvider.checkDuplicate}. */
export interface DuplicateCheck {
  isDuplicate: boolean
  existingId?: string
  score?: number
}

/**
 * Relative weights for the recall ranking blend. They are normalized
 * across whichever signals are active for a given query, so they do
 * not need to sum to 1.
 */
export interface SearchWeights {
  semantic: number
  keyword: number
  tag: number
}

/** Default ranking weights, matching the homurai memory blend. */
export const DEFAULT_SEARCH_WEIGHTS: SearchWeights = {
  semantic: 0.45,
  keyword: 0.35,
  tag: 0.2,
}

/**
 * Query shape for {@link MemoryProvider.recall}.
 *
 * With a `query` and an embedder, recall ranks by a blend of semantic
 * similarity, keyword overlap, tag overlap, and recency. With a
 * `query` but no embedder, it ranks by keyword overlap. With no
 * `query`, it returns the newest memories matching `tags`.
 */
export interface RecallQuery {
  /** Natural-language query. Embedded and ranked by similarity. */
  query?: string
  /** Only return memories that have ALL of these tags. */
  tags?: string[]
  /** Upper bound on returned records. Default 20. */
  limit?: number
  /** Minimum semantic similarity 0..1. Default 0. */
  minScore?: number
  /** Override the ranking weights for this query. */
  weights?: Partial<SearchWeights>
}

/**
 * Filter for {@link MemoryProvider.list}, a structured (non-vector) query
 * over stored memories. Every field is optional; an empty filter returns all
 * live memories newest-first.
 */
export interface ListFilter {
  /** Restrict to memories carrying these tags. */
  tags?: string[]
  /** 'all' (default) requires every tag; 'any' requires at least one. */
  tagMatch?: 'all' | 'any'
  /** Restrict to a single `type`. */
  type?: string
  /** Inclusive lower bound on importance (0..1). */
  minImportance?: number
  /** Inclusive upper bound on importance (0..1). */
  maxImportance?: number
  /** Only memories created at or after this ISO timestamp. */
  createdAfter?: string
  /** Only memories created at or before this ISO timestamp. */
  createdBefore?: string
  /** Include soft-deleted memories. Default false. */
  includeDeleted?: boolean
  /** Sort field. Default 'createdAt'. */
  sortBy?: 'createdAt' | 'updatedAt' | 'importance' | 'accessCount' | 'lastAccessed'
  /** Sort direction. Default 'desc'. */
  sortDirection?: 'asc' | 'desc'
  /** Maximum rows to return. */
  limit?: number
  /** Rows to skip (for paging). */
  offset?: number
}

/** One edge in the memory graph. */
export interface MemoryEdge {
  id: string
  fromId: string
  toId: string
  relation: string
  strength: number
  metadata: Record<string, unknown>
  createdAt: string
}

/**
 * Pluggable async embedder: text in, fixed-length number array out.
 * The length must be stable across calls. Return an empty array to opt
 * out of vector search for a given input.
 */
export type Embedder = (text: string) => Promise<number[]>

/**
 * Boot-time configuration for {@link createMemoryProvider}. Every field
 * is optional: with no config at all, memlight uses the bundled default
 * embedder and stores under the OS app-data directory.
 */
export interface MemoryProviderConfig {
  /** Explicit data directory. Overrides name/scope. 'memory://' is ephemeral. */
  dataDir?: string
  /** App name for the default OS path. Default 'memlight'. */
  name?: string
  /** Optional project id for per-project isolation under the app name. */
  scope?: string
  /** Embedder to use. Omit for the bundled default; pass 'none' for
   *  keyword and tag matching only; pass a function to bring your own. */
  embedder?: Embedder | 'none'
  /** Vector dimension. Defaults to the active embedder's output (384 for
   *  the bundled default). Fixed at the first store(). */
  vectorDim?: number
  /** Default ranking weights for every recall (overridable per query). */
  weights?: Partial<SearchWeights>
}

/** The main memlight API. */
export interface MemoryProvider {
  /** Store a memory. With `options.dedup`, returns an existing
   *  near-duplicate instead of inserting a new row. */
  store(input: StoreInput, options?: StoreOptions): Promise<StoreResult>
  /** Recall memories ranked by relevance and recency. */
  recall(query: RecallQuery): Promise<MemoryRecord[]>
  /** Structured (non-vector) query: filter by type/tags/importance/date,
   *  sort, and page. Returns full records newest-first by default. */
  list(filter?: ListFilter): Promise<MemoryRecord[]>
  /** Fetch one memory by id, or null if missing or soft-deleted. */
  get(id: string): Promise<MemoryRecord | null>
  /** Merge changes into an existing memory. Re-embeds if content changes.
   *  Returns the updated record, or null if the id does not exist. */
  update(id: string, input: UpdateInput): Promise<MemoryRecord | null>
  /** Soft-delete by default (recoverable with {@link restore}), or pass
   *  `{ hard: true }` to remove permanently. */
  delete(id: string, options?: DeleteOptions): Promise<boolean>
  /** Restore a soft-deleted memory. Returns false if it was not deleted. */
  restore(id: string): Promise<boolean>
  /** Check whether content is a near-duplicate of an existing memory. */
  checkDuplicate(content: string, threshold?: number): Promise<DuplicateCheck>
  /** Create a directed edge between two memories. */
  associate(fromId: string, toId: string, relation: string, strength?: number): Promise<MemoryEdge>
  /** List edges touching a memory (either direction). */
  neighbors(id: string): Promise<MemoryEdge[]>
  /** Count live (non-deleted) memories. */
  count(): Promise<number>
  /** Serialize all live memories and edges to a JSONL string. */
  export(format?: 'jsonl'): Promise<string>
  /** Load memories and edges from a JSONL string produced by export. */
  import(data: string, format?: 'jsonl'): Promise<{ imported: number }>
  /** Close the underlying database. */
  close(): Promise<void>
  /** Test-only: empty all tables so one provider can serve many tests. */
  _clearForTest(): Promise<void>
}
