/**
 * Retrieval quality benchmark for memlight's recall.
 *
 * Measures recall@k and MRR of the bundled default embedder over a small,
 * topic-diverse corpus using paraphrased queries (no exact keyword overlap with
 * the stored content), so it exercises genuine semantic ranking rather than
 * keyword matching. Ported from homurai, where retrieval quality was previously
 * benchmarked against a now-removed in-house search engine; it belongs here,
 * next to the recall implementation it guards.
 *
 * The model loads once (a few seconds); thresholds are set with headroom so the
 * test is a stable quality guardrail, not a micro-benchmark.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createMemoryProvider, IN_MEMORY } from '../src/index.js'
import type { MemoryProvider } from '../src/index.js'

interface Doc {
  key: string
  content: string
  tags: string[]
}

/** Topic-diverse corpus. Each doc is the sole correct answer to one query. */
const CORPUS: Doc[] = [
  {
    key: 'atomic',
    content: 'Always use atomic writes for JSON state so a crash mid-write cannot corrupt the file.',
    tags: ['storage', 'durability'],
  },
  {
    key: 'token',
    content: 'Rotate authentication tokens every 24 hours and revoke them immediately on logout.',
    tags: ['auth', 'security'],
  },
  {
    key: 'migrate',
    content: 'Run all database migrations before starting the server during a deploy.',
    tags: ['deploy', 'database'],
  },
  {
    key: 'isolation',
    content:
      'Point AGENT_ROOT at a temporary directory in tests so they never touch the real workspace.',
    tags: ['testing', 'isolation'],
  },
  {
    key: 'cache',
    content: 'The cache warms on boot by preloading the most frequently accessed records.',
    tags: ['cache', 'performance'],
  },
  {
    key: 'redact',
    content: 'Redact secrets and access tokens from log lines before they are written to disk.',
    tags: ['logging', 'security'],
  },
  {
    key: 'softdelete',
    content:
      'Soft-delete a record by moving it to an archive and keeping a deletion log so it can be restored.',
    tags: ['storage', 'archive'],
  },
  {
    key: 'backoff',
    content: 'Retry failed network calls with exponential backoff and jitter to avoid thundering herds.',
    tags: ['networking', 'resilience'],
  },
  {
    key: 'paginate',
    content: 'Paginate large API responses with an opaque cursor instead of a numeric offset.',
    tags: ['api', 'performance'],
  },
  {
    key: 'validate',
    content: 'Validate all user input at the boundary and reject malformed payloads early.',
    tags: ['validation', 'security'],
  },
  {
    key: 'fk-index',
    content: 'Index foreign-key columns so join queries stay fast as the table grows.',
    tags: ['database', 'performance'],
  },
  {
    key: 'debounce',
    content: 'Debounce expensive recomputations so rapid input changes do not thrash the CPU.',
    tags: ['performance', 'ui'],
  },
]

/** Paraphrased queries (deliberately avoid the stored wording). */
const QUERIES: Array<{ query: string; expectKey: string }> = [
  { query: 'How do we avoid a corrupted file if the process dies while saving?', expectKey: 'atomic' },
  { query: 'What is our policy for expiring login credentials?', expectKey: 'token' },
  { query: 'When are schema changes applied relative to bringing the service up?', expectKey: 'migrate' },
  { query: "How do tests stay isolated from the developer's real files?", expectKey: 'isolation' },
  { query: 'How do we keep sensitive values from leaking into log files?', expectKey: 'redact' },
  { query: 'How can a removed record be brought back later?', expectKey: 'softdelete' },
  { query: 'What strategy should we use when a remote request keeps failing?', expectKey: 'backoff' },
  { query: 'How do we return very large result sets without loading them all at once?', expectKey: 'paginate' },
]

describe('recall quality (bundled embedder)', () => {
  let memory: MemoryProvider
  const idByKey = new Map<string, string>()

  beforeAll(async () => {
    memory = await createMemoryProvider({ dataDir: IN_MEMORY })
    for (const doc of CORPUS) {
      const { id } = await memory.store({ content: doc.content, tags: doc.tags })
      idByKey.set(doc.key, id)
    }
  })

  afterAll(async () => {
    await memory.close()
  })

  it('ranks the right memory first for paraphrased queries', async () => {
    let hitsAt1 = 0
    let hitsAt3 = 0
    let mrrSum = 0

    for (const q of QUERIES) {
      const expectedId = idByKey.get(q.expectKey)!
      const hits = await memory.recall({ query: q.query, limit: 5 })
      const ids = hits.map((h) => h.id)

      const rank = ids.indexOf(expectedId)
      if (rank === 0) hitsAt1++
      if (rank >= 0 && rank < 3) hitsAt3++
      if (rank >= 0) mrrSum += 1 / (rank + 1)
    }

    const recallAt1 = hitsAt1 / QUERIES.length
    const recallAt3 = hitsAt3 / QUERIES.length
    const mrr = mrrSum / QUERIES.length

    // eslint-disable-next-line no-console
    console.log(
      `[recall-quality] recall@1=${recallAt1.toFixed(2)} recall@3=${recallAt3.toFixed(2)} mrr=${mrr.toFixed(2)}`,
    )

    // Quality guardrails with headroom (the bundled model comfortably clears these).
    expect(recallAt3).toBeGreaterThanOrEqual(0.85)
    expect(recallAt1).toBeGreaterThanOrEqual(0.6)
    expect(mrr).toBeGreaterThanOrEqual(0.7)
  })
})
