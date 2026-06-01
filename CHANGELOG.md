# Changelog

All notable changes to memlight.

## 0.1.0 — 2026-04-12

Initial public release.

- Embedded PGlite + pgvector backend with HNSW cosine index
- Pluggable embedder (`(text) => Promise<number[]>`) — bring your own
- `store / recall / get / delete / count / close` CRUD
- `associate / neighbors` 1-hop graph edges with cascade delete
- Tag scoping via `@>` JSON containment, GIN-indexed
- `memory://` ephemeral mode for tests
- 10 round-trip tests against real PGlite
