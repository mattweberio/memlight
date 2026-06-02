/**
 * get() and list() expose the stored embedding vector so host apps can run
 * their own vector math over records. recall() omits it (kept lean), and it is
 * absent when no embedder ran.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMemoryProvider, IN_MEMORY } from '../src/index.js'
import type { Embedder, MemoryProvider } from '../src/index.js'

const DIM = 4
// Deterministic embedder: tag-driven so the vector is predictable.
const fakeEmbedder: Embedder = async (text: string): Promise<number[]> => {
  const v = text.includes('alpha') ? [1, 0, 0, 0] : [0, 1, 0, 0]
  return v
}

describe('embedding exposure', () => {
  let memory: MemoryProvider

  afterEach(async () => {
    await memory.close()
  })

  it('get() and list() include the stored vector', async () => {
    memory = await createMemoryProvider({ dataDir: IN_MEMORY, embedder: fakeEmbedder, vectorDim: DIM })
    const { id } = await memory.store({ content: 'alpha topic', tags: ['t'] })

    const got = await memory.get(id)
    expect(got?.embedding).toEqual([1, 0, 0, 0])

    const listed = await memory.list({ tags: ['t'] })
    expect(listed[0]?.embedding).toEqual([1, 0, 0, 0])
  })

  it('omits embedding when no embedder is configured', async () => {
    memory = await createMemoryProvider({ dataDir: IN_MEMORY, embedder: 'none', vectorDim: DIM })
    const { id } = await memory.store({ content: 'beta topic', tags: ['t'] })
    expect((await memory.get(id))?.embedding).toBeUndefined()
    expect((await memory.list())[0]?.embedding).toBeUndefined()
  })
})
