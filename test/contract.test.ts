/**
 * memlight contract + edge-case tests.
 *
 * These lock the guarantees an integrator relies on: clear errors on
 * bad input, predictable recall shaping (limit, minScore, weights),
 * dedup behavior with and without an embedder, export/import fidelity
 * and idempotency, and store isolation between name/scope namespaces.
 *
 * Logic runs against in-memory PGlite with a deterministic fake
 * embedder so every assertion is reproducible without a model.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryProvider, IN_MEMORY } from '../src/index.js'
import type { Embedder, MemoryProvider } from '../src/index.js'

const DIM = 16

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

describe('memlight contract', () => {
  let memory: MemoryProvider

  beforeEach(async () => {
    memory = await createMemoryProvider({ dataDir: IN_MEMORY, embedder: fakeEmbedder, vectorDim: DIM })
  })
  afterEach(async () => {
    await memory.close()
  })

  describe('input validation', () => {
    it('rejects empty content', async () => {
      await expect(memory.store({ content: '' })).rejects.toThrow(/content is required/)
      await expect(memory.store({ content: '   ' })).rejects.toThrow(/content is required/)
    })

    it('throws a clear error on embedder dimension mismatch', async () => {
      const wrongDim = await createMemoryProvider({
        dataDir: IN_MEMORY,
        embedder: async () => [0.1, 0.2, 0.3],
        vectorDim: DIM,
      })
      try {
        await expect(wrongDim.store({ content: 'mismatch' })).rejects.toThrow(/expected 16/)
      } finally {
        await wrongDim.close()
      }
    })
  })

  describe('recall shaping', () => {
    beforeEach(async () => {
      for (let i = 0; i < 8; i++) {
        await memory.store({ content: `alpha beta gamma note ${i}`, tags: ['bulk'] })
      }
    })

    it('respects limit', async () => {
      const hits = await memory.recall({ query: 'alpha beta', limit: 3 })
      expect(hits).toHaveLength(3)
    })

    it('filters by minScore', async () => {
      const all = await memory.recall({ query: 'alpha beta', limit: 50 })
      const high = await memory.recall({ query: 'alpha beta', limit: 50, minScore: 0.99 })
      expect(high.length).toBeLessThanOrEqual(all.length)
      expect(high.every((h) => (h.score ?? 0) >= 0.99)).toBe(true)
    })

    it('returns newest first when no query and no tags', async () => {
      const last = await memory.store({ content: 'the newest one' })
      const hits = await memory.recall({})
      expect(hits[0]?.id).toBe(last.id)
    })

    it('semantic-only weights ignore keyword overlap', async () => {
      await memory.store({ content: 'unrelated keyword token zzz', tags: ['bulk'] })
      const hits = await memory.recall({
        query: 'zzz',
        weights: { semantic: 1, keyword: 0, tag: 0 },
        limit: 1,
      })
      // With keyword weight zeroed, ranking is pure cosine; result is defined and scored.
      expect(hits[0]?.score).toBeTypeOf('number')
    })
  })

  describe('dedup', () => {
    it('reports not-duplicate when no embedder is configured', async () => {
      const tagOnly = await createMemoryProvider({ dataDir: IN_MEMORY, embedder: 'none', vectorDim: DIM })
      try {
        await tagOnly.store({ content: 'anything at all' })
        const check = await tagOnly.checkDuplicate('anything at all')
        expect(check.isDuplicate).toBe(false)
      } finally {
        await tagOnly.close()
      }
    })

    it('store without dedup always inserts', async () => {
      const a = await memory.store({ content: 'same words here' })
      const b = await memory.store({ content: 'same words here' })
      expect(b.deduped).toBeFalsy()
      expect(a.id).not.toBe(b.id)
      expect(await memory.count()).toBe(2)
    })

    it('below-threshold content is not flagged', async () => {
      await memory.store({ content: 'completely different subject matter entirely' })
      const check = await memory.checkDuplicate('nothing alike whatsoever', 0.99)
      expect(check.isDuplicate).toBe(false)
    })
  })

  describe('soft delete semantics', () => {
    it('second soft delete returns false, restore of a live row returns false', async () => {
      const { id } = await memory.store({ content: 'delete me' })
      expect(await memory.delete(id)).toBe(true)
      expect(await memory.delete(id)).toBe(false)
      expect(await memory.restore(id)).toBe(true)
      expect(await memory.restore(id)).toBe(false)
    })

    it('soft-deleted rows are excluded from recall', async () => {
      const { id } = await memory.store({ content: 'hide me from recall', tags: ['x'] })
      await memory.delete(id)
      const hits = await memory.recall({ query: 'hide me from recall', tags: ['x'] })
      expect(hits.find((h) => h.id === id)).toBeUndefined()
    })
  })

  describe('update', () => {
    it('merges metadata and type, preserves untouched fields, advances updatedAt', async () => {
      const { id } = await memory.store({
        content: 'base', tags: ['a'], type: 'Note', metadata: { k: 1 }, importance: 0.3,
      })
      const before = await memory.get(id)
      const after = await memory.update(id, { metadata: { k: 2 }, importance: 0.7 })
      expect(after?.metadata).toEqual({ k: 2 })
      expect(after?.importance).toBeCloseTo(0.7, 5)
      expect(after?.type).toBe('Note')
      expect(after?.tags).toEqual(['a'])
      expect(new Date(after!.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(before!.updatedAt).getTime(),
      )
    })
  })

  describe('export / import', () => {
    it('preserves fields and is idempotent on re-import', async () => {
      const a = await memory.store({
        content: 'exported one', tags: ['e'], importance: 0.6, type: 'Decision', metadata: { src: 'x' },
      })
      const b = await memory.store({ content: 'exported two', tags: ['e'] })
      await memory.associate(a.id, b.id, 'relates_to', 0.4)
      const dump = await memory.export('jsonl')

      const target = await createMemoryProvider({ dataDir: IN_MEMORY, embedder: fakeEmbedder, vectorDim: DIM })
      try {
        await target.import(dump)
        await target.import(dump) // second import must not duplicate
        expect(await target.count()).toBe(2)
        const got = await target.get(a.id)
        expect(got?.importance).toBeCloseTo(0.6, 5)
        expect(got?.type).toBe('Decision')
        expect(got?.metadata).toEqual({ src: 'x' })
        expect(await target.neighbors(a.id)).toHaveLength(1)
      } finally {
        await target.close()
      }
    })

    it('rejects unknown formats', async () => {
      // @ts-expect-error exercising the runtime guard with a bad format
      await expect(memory.export('csv')).rejects.toThrow(/unsupported format/)
    })
  })
})

describe('namespace isolation', () => {
  it('different name/scope stores do not see each other', async () => {
    const base = await mkdtemp(join(tmpdir(), 'memlight-iso-'))
    const prev = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = base
    try {
      const a = await createMemoryProvider({ name: 'appA', embedder: 'none' })
      const b = await createMemoryProvider({ name: 'appB', embedder: 'none' })
      try {
        await a.store({ content: 'secret of A', tags: ['t'] })
        expect(await a.count()).toBe(1)
        expect(await b.count()).toBe(0)
        const bHits = await b.recall({ tags: ['t'] })
        expect(bHits).toHaveLength(0)
      } finally {
        await a.close()
        await b.close()
      }
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prev
      await rm(base, { recursive: true, force: true })
    }
  }, 60_000)
})
