/**
 * memlight v0.2 feature tests: update, hybrid ranking, decay/recency,
 * dedup, export/import, path resolution, and the bundled default
 * embedder.
 *
 * Logic tests use a deterministic fake embedder (token-hash to a small
 * fixed dimension) so similarity is reproducible without a model. One
 * test loads the real bundled model to confirm it produces 384-dim
 * vectors and powers zero-config recall.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryProvider,
  createDefaultEmbedder,
  resolveDataDir,
  osDataRoot,
  IN_MEMORY,
} from '../src/index.js'
import type { Embedder, MemoryProvider } from '../src/index.js'

const DIM = 16

/** Deterministic fake embedder: token-hash into buckets, then normalize. */
const fakeEmbedder: Embedder = async (text: string): Promise<number[]> => {
  const vec = new Array<number>(DIM).fill(0)
  for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0
    vec[h % DIM]! += 1
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map((v) => v / norm)
}

describe('memlight v0.2 features', () => {
  let memory: MemoryProvider

  beforeEach(async () => {
    memory = await createMemoryProvider({ dataDir: IN_MEMORY, embedder: fakeEmbedder, vectorDim: DIM })
  })
  afterEach(async () => {
    await memory.close()
  })

  it('update merges fields and re-embeds on content change', async () => {
    const { id } = await memory.store({
      content: 'original note about the deploy pipeline',
      tags: ['ops'],
      importance: 0.4,
    })
    const updated = await memory.update(id, { importance: 0.9, tags: ['ops', 'urgent'] })
    expect(updated?.importance).toBeCloseTo(0.9, 5)
    expect(updated?.tags).toEqual(['ops', 'urgent'])
    expect(updated?.content).toBe('original note about the deploy pipeline')

    const recontent = await memory.update(id, { content: 'rewritten note about rollbacks' })
    expect(recontent?.content).toBe('rewritten note about rollbacks')
    const hits = await memory.recall({ query: 'rollbacks' })
    expect(hits[0]?.id).toBe(id)
  })

  it('update on an unknown id returns null', async () => {
    const result = await memory.update('00000000-0000-0000-0000-000000000000', { importance: 1 })
    expect(result).toBeNull()
  })

  it('recall weights can force keyword ordering over semantics', async () => {
    await memory.store({ content: 'postgres vacuum tuning notes', tags: ['db'] })
    await memory.store({ content: 'redis eviction policy notes', tags: ['db'] })
    const hits = await memory.recall({
      query: 'redis eviction',
      weights: { semantic: 0, keyword: 1, tag: 0 },
      limit: 2,
    })
    expect(hits[0]?.content).toContain('redis')
  })

  it('decay: a freshly updated memory ranks above an equal stale one', async () => {
    const a = await memory.store({ content: 'identical content for decay test', tags: ['t'] })
    const b = await memory.store({ content: 'identical content for decay test', tags: ['t'] })
    // Touch A so its recency timestamp is the newest.
    await memory.update(a.id, { importance: 0.5 })
    const hits = await memory.recall({ query: 'identical content for decay test', tags: ['t'], limit: 2 })
    expect(hits.map((h) => h.id)).toEqual([a.id, b.id])
  })

  it('checkDuplicate flags near-identical content; store dedup skips it', async () => {
    const first = await memory.store({ content: 'the cat sat on the mat' })
    const check = await memory.checkDuplicate('the cat sat on the mat')
    expect(check.isDuplicate).toBe(true)
    expect(check.existingId).toBe(first.id)

    const second = await memory.store({ content: 'the cat sat on the mat' }, { dedup: true })
    expect(second.deduped).toBe(true)
    expect(second.id).toBe(first.id)
    expect(await memory.count()).toBe(1)
  })

  it('access count increments on recall', async () => {
    const { id } = await memory.store({ content: 'tracked memory', tags: ['x'] })
    await memory.recall({ query: 'tracked memory' })
    const got = await memory.get(id)
    expect(got?.accessCount).toBeGreaterThanOrEqual(1)
    expect(got?.lastAccessed).not.toBeNull()
  })

  it('export then import round-trips memories and edges', async () => {
    const a = await memory.store({ content: 'first exported memory', tags: ['e'], importance: 0.7 })
    const b = await memory.store({ content: 'second exported memory', tags: ['e'] })
    await memory.associate(a.id, b.id, 'relates_to', 0.6)
    const dump = await memory.export('jsonl')

    const restored = await createMemoryProvider({ dataDir: IN_MEMORY, embedder: fakeEmbedder, vectorDim: DIM })
    try {
      const { imported } = await restored.import(dump)
      expect(imported).toBe(3)
      expect(await restored.count()).toBe(2)
      expect((await restored.get(a.id))?.content).toBe('first exported memory')
      const edges = await restored.neighbors(a.id)
      expect(edges).toHaveLength(1)
      expect(edges[0]?.relation).toBe('relates_to')
    } finally {
      await restored.close()
    }
  })
})

describe('path resolution', () => {
  it('passes memory:// through untouched', () => {
    expect(resolveDataDir({ dataDir: IN_MEMORY })).toBe(IN_MEMORY)
  })

  it('builds <os-data>/<name>/<scope> and creates it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'memlight-xdg-'))
    const prev = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = base
    try {
      const dir = resolveDataDir({ name: 'akemi-test', scope: 'mattweberio/homurai' })
      expect(dir).toBe(join(osDataRoot(), 'akemi-test', 'mattweberio-homurai'))
      expect(existsSync(dir)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prev
      await rm(base, { recursive: true, force: true })
    }
  })
})

describe('bundled default embedder', () => {
  it('produces 384-dim normalized vectors', async () => {
    const embed = createDefaultEmbedder()
    const vec = await embed('a short sentence about memory')
    expect(vec).toHaveLength(384)
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
    expect(norm).toBeCloseTo(1, 2)
  }, 120_000)

  it('powers zero-config recall (default embedder, in-memory)', async () => {
    const memory = await createMemoryProvider({ dataDir: IN_MEMORY })
    try {
      await memory.store({ content: 'The capital of France is Paris', tags: ['geo'] })
      await memory.store({ content: 'Espresso is brewed under pressure', tags: ['coffee'] })
      const hits = await memory.recall({ query: 'what is the capital of France', limit: 1 })
      expect(hits[0]?.content).toContain('Paris')
      expect(hits[0]?.score).toBeGreaterThan(0)
    } finally {
      await memory.close()
    }
  }, 120_000)
})
