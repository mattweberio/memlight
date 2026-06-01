# Changelog

All notable changes to memlight.

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
