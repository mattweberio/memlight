/**
 * memlight v0.2 persistence tests.
 *
 * The features added in 0.2 (update, soft delete + restore, access
 * tracking) must survive a close and reopen against a real on-disk
 * data directory, not just live in one process. Each test uses its
 * own tmp dir and reopens a fresh provider against it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryProvider } from '../src/index.js'
import type { Embedder } from '../src/index.js'

const DIM = 8
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

describe('v0.2 persistence across reopen', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memlight-v2-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function open() {
    return createMemoryProvider({ dataDir: dir, embedder: fakeEmbedder, vectorDim: DIM })
  }

  it('an update survives close and reopen', async () => {
    let m = await open()
    const { id } = await m.store({ content: 'first version', importance: 0.2 })
    await m.update(id, { content: 'second version', importance: 0.9 })
    await m.close()

    m = await open()
    try {
      const got = await m.get(id)
      expect(got?.content).toBe('second version')
      expect(got?.importance).toBeCloseTo(0.9, 5)
    } finally {
      await m.close()
    }
  }, 60_000)

  it('a soft delete survives reopen and is still restorable', async () => {
    let m = await open()
    const { id } = await m.store({ content: 'recoverable across sessions', tags: ['k'] })
    await m.delete(id)
    await m.close()

    m = await open()
    try {
      expect(await m.get(id)).toBeNull()
      expect(await m.count()).toBe(0)
      expect(await m.restore(id)).toBe(true)
      expect((await m.get(id))?.content).toBe('recoverable across sessions')
    } finally {
      await m.close()
    }
  }, 60_000)

  it('access count and lastAccessed persist after reopen', async () => {
    let m = await open()
    const { id } = await m.store({ content: 'tracked across sessions', tags: ['a'] })
    await m.recall({ query: 'tracked across sessions' })
    await m.close()

    m = await open()
    try {
      const got = await m.get(id)
      expect(got?.accessCount).toBeGreaterThanOrEqual(1)
      expect(got?.lastAccessed).not.toBeNull()
    } finally {
      await m.close()
    }
  }, 60_000)
})
