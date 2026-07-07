# Changelog

All notable changes to memlight.

## 0.4.1 (2026-07-07)

- Clarified npm README wording around the default embedder: semantic search uses
  a lazy local model with a shared cache, while `embedder: 'none'` avoids model
  download entirely.
- Refreshed package metadata for the public npm listing.

## 0.4.0 (2026-06-02)

- `recall()` now accepts the same structured filters as `list()` (type, tags
  with all/any match, importance range, created-at range). They restrict the
  candidate set before ranking, so recall is a filtered semantic search. The
  filter-building is shared between recall and list (one code path).

## 0.3.1 (2026-06-02)

- `get()` and `list()` now include the stored `embedding` vector on each record,
  so host apps can run their own vector math without a second embedder. recall()
  still omits it (kept lean), and it is absent when no embedder ran.

## 0.3.0 (2026-06-02)

- `list(filter)`: a structured, non-vector query over stored memories. Filter
  by `type`, `tags` (match all or any), importance range, and created-at range;
  sort by createdAt / updatedAt / importance / accessCount / lastAccessed; page
  with limit + offset; optionally include soft-deleted. Returns full records.
  Complements `recall` (semantic) for host apps that need exact filtered listing
  and aggregate stats.

## 0.2.0 (2026-06-01)

Zero-config release. memlight now works with no arguments.

- Bundled default embedder: `Xenova/bge-small-en-v1.5` (384 dims, local, via
  transformers.js). Loaded lazily and cached on disk. Still swappable, and
  `embedder: 'none'` keeps the keyword and tag path.
- Default OS app-data storage, namespaced by `name` and optional `scope`.
  `dataDir` is now optional. Memory no longer needs to live in a repo.
- Hybrid recall: blends semantic similarity, keyword overlap, tag overlap, and
  recency, with an importance lift. Weights are configurable per query.
- First-class `update(id, input)` with merge and re-embedding on content change.
- Soft delete by default with `restore(id)`; `delete(id, { hard: true })` for
  permanent removal.
- `checkDuplicate(content, threshold)` and `store(input, { dedup: true })`.
- `export('jsonl')` and `import(data)` for backup and restore.
- Access tracking (`accessCount`, `lastAccessed`) feeding recency ranking.
- Schema migration v2 (additive columns and indexes); existing stores upgrade
  in place.

## 0.1.0 (2026-04-12)

Initial public release.

- Embedded PGlite + pgvector backend with HNSW cosine index
- Pluggable embedder (`(text) => Promise<number[]>`)
- `store / recall / get / delete / count / close` CRUD
- `associate / neighbors` 1-hop graph edges with cascade delete
- Tag scoping via `@>` JSON containment, GIN-indexed
- `memory://` ephemeral mode for tests
- Round-trip tests against real PGlite
