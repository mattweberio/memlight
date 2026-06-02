/**
 * recall() structured filters: type / tags / importance range / date restrict
 * the candidate set before semantic (and keyword) ranking, sharing the same
 * filter logic as list().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

describe('recall() structured filters', () => {
  let memory: MemoryProvider
  let a: string
  let b: string
  let c: string

  beforeEach(async () => {
    memory = await createMemoryProvider({ dataDir: IN_MEMORY, embedder: fakeEmbedder, vectorDim: DIM })
    a = (await memory.store({ content: 'alpha topic', type: 'note', importance: 0.9, tags: ['x'] })).id
    b = (await memory.store({ content: 'alpha topic two', type: 'decision', importance: 0.3, tags: ['x', 'y'] })).id
    c = (await memory.store({ content: 'beta unrelated', type: 'note', importance: 0.5, tags: ['z'] })).id
  })
  afterEach(async () => {
    await memory.close()
  })

  it('filters recall by type, then ranks by query', async () => {
    const hits = await memory.recall({ query: 'alpha', type: 'note' })
    expect(hits.every((h) => h.type === 'note')).toBe(true)
    expect(hits.find((h) => h.id === b)).toBeUndefined()
    expect(hits[0]?.id).toBe(a)
  })

  it('filters recall by minimum importance', async () => {
    const hits = await memory.recall({ query: 'alpha', minImportance: 0.5 })
    const ids = hits.map((h) => h.id)
    expect(ids).toContain(a)
    expect(ids).not.toContain(b)
  })

  it('filters recall by tag (any) before ranking', async () => {
    const hits = await memory.recall({ query: 'alpha', tags: ['y'] })
    expect(hits.map((h) => h.id)).toEqual([b])
    const either = await memory.recall({ query: 'alpha', tags: ['x', 'y'], tagMatch: 'any' })
    expect(new Set(either.map((h) => h.id))).toEqual(new Set([a, b]))
  })

  it('applies filters on the keyword path too (no embedder)', async () => {
    const tagOnly = await createMemoryProvider({ dataDir: IN_MEMORY, embedder: 'none', vectorDim: DIM })
    try {
      await tagOnly.store({ content: 'alpha note', type: 'note' })
      await tagOnly.store({ content: 'alpha decision', type: 'decision' })
      const hits = await tagOnly.recall({ query: 'alpha', type: 'note' })
      expect(hits.every((h) => h.type === 'note')).toBe(true)
      expect(hits.length).toBe(1)
    } finally {
      await tagOnly.close()
    }
  })

  it('keeps c (beta) out of an alpha query at a reasonable threshold', async () => {
    const hits = await memory.recall({ query: 'alpha', minScore: 0.5 })
    expect(hits.map((h) => h.id)).not.toContain(c)
  })
})
