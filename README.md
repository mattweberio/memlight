# memlight

[![npm version](https://img.shields.io/npm/v/memlight.svg)](https://www.npmjs.com/package/memlight)
[![npm downloads](https://img.shields.io/npm/dm/memlight.svg)](https://www.npmjs.com/package/memlight)
[![license](https://img.shields.io/npm/l/memlight.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/memlight.svg)](./dist/index.d.ts)
[![node](https://img.shields.io/node/v/memlight.svg)](https://nodejs.org)

Embedded vector memory for AI agents. It runs inside your process, stores on the local machine, and works with no configuration. There is no server to run, no API key to set, and nothing to wire up before the first `store`.

It is built on [PGlite](https://github.com/electric-sql/pglite) (Postgres compiled to WebAssembly) with [pgvector](https://github.com/pgvector/pgvector) for similarity search, and ships a local embedding model so semantic recall works out of the box.

## Quick start

```ts
import { createMemoryProvider } from 'memlight'

const memory = await createMemoryProvider()

await memory.store({
  content: 'Matt prefers concise answers with examples',
  tags: ['preference', 'communication'],
  importance: 0.8,
})

const hits = await memory.recall({ query: 'how does Matt like to be talked to' })
// hits[0].content -> 'Matt prefers concise answers with examples'
```

That is the whole setup. No data directory, no embedder, no keys.

## Install

```bash
npm add memlight
pnpm add memlight
bun add memlight
```

Requires Node 22 or newer.

## What it is

- **Zero config.** A bundled local embedder and an automatic storage location mean a working memory in two lines.
- **Semantic recall.** Real cosine similarity over pgvector, blended with keyword overlap, tag overlap, and recency.
- **Local and private.** Everything runs in process. No network at query time, no third party, no key.
- **Embedded.** The whole database lives in one directory under the user's home. No Postgres server, no Docker, no native build.
- **Swappable.** Bring your own embedder (Ollama, OpenAI, anything) when you want to.

## What it is not

- Not a multi-process database. PGlite is single writer. One process owns a store at a time.
- Not a distributed system. When your data outgrows a single machine, the schema is ordinary Postgres, so `pg_dump` and restore into a real Postgres with pgvector and your code keeps working.

## Defaults

| Concern | Default | Override |
| --- | --- | --- |
| Embedder | `Xenova/bge-small-en-v1.5`, 384 dims, local | `embedder` option |
| Storage | OS app-data dir, namespaced by `name` | `dataDir`, `name`, `scope` |
| Recall | Hybrid: semantic + keyword + tag + recency | `weights` option |
| Delete | Soft delete, recoverable | `delete(id, { hard: true })` |

The model downloads once on first use and is cached on disk. After that it loads in about a second with no network.

## Storage location

memlight stores in the operating system's app-data directory, not in your repo or working directory. Pick a logical location with `name` (the app) and an optional `scope` (a project), and memlight resolves the real path for you.

```ts
// <os-data>/akemi
const akemi = await createMemoryProvider({ name: 'akemi' })

// <os-data>/homurai/mattweberio-homurai
const project = await createMemoryProvider({ name: 'homurai', scope: 'mattweberio/homurai' })

// exact path, your call
const custom = await createMemoryProvider({ dataDir: '/srv/data/memory' })
```

The os-data root by platform:

| Platform | Root |
| --- | --- |
| Linux and others | `$XDG_DATA_HOME` or `~/.local/share` |
| macOS | `~/Library/Application Support` |
| Windows | `%APPDATA%` or `~/AppData/Roaming` |

## API

```ts
interface MemoryProvider {
  store(input: StoreInput, options?: StoreOptions): Promise<StoreResult>
  recall(query: RecallQuery): Promise<MemoryRecord[]>
  list(filter?: ListFilter): Promise<MemoryRecord[]>
  get(id: string): Promise<MemoryRecord | null>
  update(id: string, input: UpdateInput): Promise<MemoryRecord | null>
  delete(id: string, options?: DeleteOptions): Promise<boolean>
  restore(id: string): Promise<boolean>
  checkDuplicate(content: string, threshold?: number): Promise<DuplicateCheck>
  associate(fromId: string, toId: string, relation: string, strength?: number): Promise<MemoryEdge>
  neighbors(id: string): Promise<MemoryEdge[]>
  count(): Promise<number>
  export(format?: 'jsonl'): Promise<string>
  import(data: string, format?: 'jsonl'): Promise<{ imported: number }>
  close(): Promise<void>
}
```

### store

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Optional. A UUID is generated when omitted. Pass an id to upsert. |
| `content` | `string` | Required. Empty content throws. |
| `tags` | `string[]` | Default `[]`. Recall can filter to memories that have all of a set of tags. |
| `importance` | `number` | 0 to 1. Nudges recall ranking. |
| `type` | `string` | Free-form label such as `Decision`, `Preference`. |
| `metadata` | `Record<string, unknown>` | Stored as JSON. Anything serializable. |

Pass `{ dedup: true }` as the second argument to skip the write and return the existing memory when a near-duplicate is already stored.

### recall

| Field | Type | Notes |
| --- | --- | --- |
| `query` | `string` | Natural language. Embedded and ranked by similarity. |
| `tags` | `string[]` | Only return memories that have all of these tags. |
| `limit` | `number` | Default 20. |
| `minScore` | `number` | Minimum semantic similarity 0 to 1. Default 0. |
| `weights` | `Partial<SearchWeights>` | Override the ranking blend for this query. |

Recall ranks by a blend of semantic similarity, keyword overlap, tag overlap, and recency, with a small lift for higher importance. The default weights are `{ semantic: 0.45, keyword: 0.35, tag: 0.2 }` and they are renormalized across whichever signals a query actually uses. With a query and no embedder, recall ranks by keyword overlap. With no query, it returns the newest memories matching `tags`.

### list

A structured, non-vector query for when you want exact filtering and ordering rather than relevance ranking. Use `recall` to answer "what is most relevant to this query"; use `list` to answer "give me these memories, filtered and sorted".

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `string` | Restrict to one type. |
| `tags` | `string[]` | Restrict to these tags. |
| `tagMatch` | `'all' \| 'any'` | `'all'` (default) requires every tag; `'any'` requires at least one. |
| `minImportance` / `maxImportance` | `number` | Inclusive importance bounds (0 to 1). |
| `createdAfter` / `createdBefore` | `string` | Inclusive ISO timestamp bounds. |
| `includeDeleted` | `boolean` | Include soft-deleted memories. Default false. |
| `sortBy` | `string` | `createdAt` (default), `updatedAt`, `importance`, `accessCount`, or `lastAccessed`. |
| `sortDirection` | `'asc' \| 'desc'` | Default `desc`. |
| `limit` / `offset` | `number` | Paging. |

```ts
const recent = await memory.list({ type: 'note', tags: ['project'], minImportance: 0.5, limit: 20 })
```

### config

| Field | Type | Notes |
| --- | --- | --- |
| `dataDir` | `string` | Explicit path. Overrides `name` and `scope`. `'memory://'` is ephemeral. |
| `name` | `string` | App name for the default path. Default `memlight`. |
| `scope` | `string` | Optional project id for per-project isolation. |
| `embedder` | `Embedder \| 'none'` | Omit for the bundled default. `'none'` is keyword and tag only. A function brings your own. |
| `vectorDim` | `number` | Defaults to the embedder's output (384 for the bundled default). Fixed at the first store. |
| `weights` | `Partial<SearchWeights>` | Default ranking weights for every recall. |

## Swapping the embedder

The embedder is just `(text: string) => Promise<number[]>`. Pass your own to use a different model, and set `vectorDim` to match its output.

```ts
// Ollama, local, free
const memory = await createMemoryProvider({
  vectorDim: 768,
  embedder: async (text) => {
    const res = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    })
    const { embedding } = await res.json()
    return embedding
  },
})
```

```ts
// Keyword and tag matching only, no vectors
const memory = await createMemoryProvider({ embedder: 'none' })
```

## In-memory mode

Pass `'memory://'` for an ephemeral database with no disk writes. Useful for tests.

```ts
const memory = await createMemoryProvider({ dataDir: 'memory://' })
```

## Graph edges

Relate memories to each other and read the edges back.

```ts
await memory.associate(planId, blockerId, 'blocked_by', 0.8)
const edges = await memory.neighbors(planId)
```

## Soft delete and restore

Delete is recoverable by default. A soft-deleted memory drops out of recall, `get`, and `count`, and comes back with `restore`. Pass `{ hard: true }` to remove it for good.

```ts
await memory.delete(id)                  // recoverable
await memory.restore(id)                 // back
await memory.delete(id, { hard: true })  // gone
```

## Backup

```ts
const dump = await memory.export('jsonl')   // every live memory and edge
await other.import(dump)                     // load it elsewhere
```

Export carries content, tags, importance, type, metadata, and edges. Embeddings are rebuilt on import, so a backup is portable across embedders.

## Limitations

- **Single process.** Opening the same store from two processes at once is unsupported.
- **Recall reranks a candidate pool.** For very large stores the keyword and recency rerank runs over a bounded candidate set, not the entire table. Personal scale (tens of thousands of memories) is comfortable.
- **Importance and recency are heuristics.** They nudge ranking; they do not expire memories. There is no TTL yet.

## License

MIT. See [LICENSE](./LICENSE).

## Source and issues

[github.com/mattweberio/memlight](https://github.com/mattweberio/memlight)
