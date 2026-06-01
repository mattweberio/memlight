# memlight

**Embedded vector memory for AI agents.** PGlite + pgvector, pluggable embedder, graph edges, tag scoping. Zero-install — no Postgres server, no network, no API key required.

```bash
npm install memlight
```

```ts
import { createMemoryProvider } from 'memlight';

const memory = await createMemoryProvider({
  dataDir: './data/memory',
  embed: async (text) => {
    // Plug in any async function that returns a fixed-length number array.
    // Local Ollama, OpenAI, ONNX, anything.
    const res = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    });
    const { embedding } = await res.json();
    return embedding;
  },
  vectorDim: 768, // must match your embedder's output
});

await memory.store({
  content: 'Matt prefers concise responses with examples',
  tags: ['preference', 'communication'],
  importance: 0.8,
});

const hits = await memory.recall({
  query: 'how does Matt like to be talked to',
  tags: ['preference'],
  limit: 5,
});
// → [{ id, content, tags, score: 0.87, ... }]
```

## What it is

- **Vector recall** via [pgvector](https://github.com/pgvector/pgvector) running inside [PGlite](https://github.com/electric-sql/pglite). Real cosine similarity, HNSW-indexed, query-by-natural-language.
- **Tag scoping** layered on top — every memory carries `tags`, recall can filter to `tags @> [a, b]` (AND semantics) and the vector query runs within that subset.
- **Graph edges** — `associate(fromId, toId, relation, strength)` and `neighbors(id)`. v0.1 ships 1-hop lookup; full traversal is on the v0.2 roadmap.
- **Pluggable embedder** — bring your own async function. memlight calls it at store time and recall time. No model download bundled, no opinion on which provider you use.
- **Zero-install** — PGlite is a WASM build of Postgres. No native compile, no Postgres server, no Docker, no Homebrew.
- **Node 22+** because PGlite needs the modern WebAssembly streaming compile path.

## Why not just use Postgres + pgvector?

You can — and once your data outgrows a single process, you should. memlight is for the **embedded** case: a desktop AI assistant, a CLI tool, a single-user agent. The whole DB lives in one directory under the user's home; no server to manage, no port to open.

When you outgrow it, the schema is ordinary Postgres — `pg_dump` + `psql restore` into a real Postgres + pgvector and your code keeps working with the same SQL.

## API

```ts
interface MemoryProvider {
  store(input: StoreInput): Promise<{ id: string }>;
  recall(query: RecallQuery): Promise<MemoryRecord[]>;
  get(id: string): Promise<MemoryRecord | null>;
  delete(id: string): Promise<boolean>;
  associate(fromId: string, toId: string, relation: string, strength?: number): Promise<MemoryEdge>;
  neighbors(id: string): Promise<MemoryEdge[]>;
  count(): Promise<number>;
  close(): Promise<void>;
}
```

### `store(input)`

| Field | Type | Notes |
|---|---|---|
| `id` | `string?` | Optional. memlight generates a UUIDv4 if omitted. Pass an explicit id to upsert. |
| `content` | `string` | Required. Empty/whitespace content throws. |
| `tags` | `string[]?` | Default `[]`. memlight indexes these with a GIN index for fast `@>` containment queries. |
| `importance` | `number?` | 0..1. Stored for future decay strategies; does not affect recall ranking in v0.1. |
| `type` | `string?` | Free-form label like `'Decision'`, `'Preference'`, `'Insight'`. memlight does not enumerate. |
| `metadata` | `Record<string, unknown>?` | Stored as `jsonb`. Anything JSON-serializable. |

### `recall(query)`

| Field | Type | Notes |
|---|---|---|
| `query` | `string?` | Natural-language query. Embedded via the configured embedder; cosine-ranked against memory vectors. Optional. |
| `tags` | `string[]?` | Only return memories that have **all** of these tags (`@>` containment). |
| `limit` | `number?` | Default 20. |
| `minScore` | `number?` | Filter out results with score below this threshold. Default 0 (no threshold). |

When no embedder is configured **or** no `query` is given, recall falls back to the tag-only path: filtered rows ordered by `created_at DESC`.

### `associate(from, to, relation, strength?)` / `neighbors(id)`

Lightweight graph layer. `associate('a-1', 'b-2', 'caused-by', 0.7)` writes an edge. `neighbors('a-1')` returns every edge where `a-1` is on either end. Cascade deletes happen via FK on the `memory_edges` table — deleting a memory removes its edges.

## Embedder

memlight does not ship an embedder. You bring one:

| Backend | Cost | Setup |
|---|---|---|
| **[Ollama](https://ollama.com)** with `nomic-embed-text` | free, local, no network | `ollama pull nomic-embed-text` |
| **OpenAI `text-embedding-3-small`** | ~$0.02 / 1M tokens | API key |
| **Local ONNX** via `@xenova/transformers` | free, ~80 MB model download on first use | npm install + initial download |
| **`undefined`** | — | falls back to tag-only recall |

The embedder type is just `(text: string) => Promise<number[]>`. memlight fixes the column dimension on the first `store()` call based on the array length the embedder returned, so the embedder must produce a stable dim across calls.

## Configuration

```ts
interface MemoryProviderConfig {
  dataDir: string;            // required, must be writable
  embed?: Embedder;           // optional, falls back to tag-only when absent
  vectorDim?: number;         // default 384, must match embedder output
}
```

## In-memory mode for tests

```ts
const memory = await createMemoryProvider({ dataDir: 'memory://' });
```

PGlite supports the `memory://` URI for ephemeral in-memory databases — no disk writes, no cleanup. Useful for unit tests; do not use for production.

## Limitations (v0.1)

- **Single process.** PGlite is designed for one connection; opening the same `dataDir` from two processes is undefined behavior. The embedding daemon should be the only writer.
- **No automatic schema migrations.** v0.1 schema is `CREATE TABLE IF NOT EXISTS`. When v0.2 ships schema changes, an explicit migration runner ships with it.
- **No decay or expiry.** `importance` is stored but unused for ranking. v0.2 adds time-weighted decay.
- **No backup/export tool.** `pg_dump` works against the PGlite data directory; a built-in `memlight export` ships in v0.2.
- **`limit` is post-filter, not push-down for `tags`.** With very large stores you'll feel this; for personal-scale (tens of thousands of memories) it's fine.

## License

MIT. See [LICENSE](./LICENSE).

## Where to find me

Source and issues: [github.com/mattweberio/memlight](https://github.com/mattweberio/memlight). Published to npm as [`memlight`](https://www.npmjs.com/package/memlight).
