/**
 * memlight list() tests: the structured (non-vector) query surface.
 *
 * Covers type / tag (all + any) / importance-range / date-range / soft-delete
 * filtering, sort field + direction, and limit/offset paging. Uses in-memory
 * PGlite with no embedder (list does not need vectors).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMemoryProvider, IN_MEMORY } from '../src/index.js'
import type { MemoryProvider } from '../src/index.js'

describe('list()', () => {
  let memory: MemoryProvider

  beforeEach(async () => {
    memory = await createMemoryProvider({ dataDir: IN_MEMORY, embedder: 'none' })
  })
  afterEach(async () => {
    await memory.close()
  })

  it('returns all live memories newest-first by default', async () => {
    const a = await memory.store({ content: 'first' })
    const b = await memory.store({ content: 'second' })
    const c = await memory.store({ content: 'third' })
    const rows = await memory.list()
    expect(rows.map((r) => r.id)).toEqual([c.id, b.id, a.id])
  })

  it('filters by type', async () => {
    await memory.store({ content: 'a note', type: 'note' })
    await memory.store({ content: 'a decision', type: 'decision' })
    const rows = await memory.list({ type: 'note' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('note')
  })

  it('tag match all (default) requires every tag; any requires one', async () => {
    await memory.store({ content: 'A', tags: ['x', 'y'] })
    await memory.store({ content: 'B', tags: ['x'] })
    await memory.store({ content: 'C', tags: ['z'] })

    const all = await memory.list({ tags: ['x', 'y'] })
    expect(all.map((r) => r.content)).toEqual(['A'])

    const any = await memory.list({ tags: ['x', 'y'], tagMatch: 'any' })
    expect(new Set(any.map((r) => r.content))).toEqual(new Set(['A', 'B']))
  })

  it('filters by importance range', async () => {
    await memory.store({ content: 'low', importance: 0.2 })
    await memory.store({ content: 'mid', importance: 0.5 })
    await memory.store({ content: 'high', importance: 0.9 })
    const rows = await memory.list({ minImportance: 0.4, maxImportance: 0.8 })
    expect(rows.map((r) => r.content)).toEqual(['mid'])
  })

  it('filters by created-at range', async () => {
    const a = await memory.store({ content: 'a' })
    const b = await memory.store({ content: 'b' })
    const c = await memory.store({ content: 'c' })
    const bAt = (await memory.get(b.id))!.createdAt
    const fromB = await memory.list({ createdAfter: bAt, sortBy: 'createdAt', sortDirection: 'asc' })
    expect(fromB.map((r) => r.id)).toEqual([b.id, c.id])
    const upToB = await memory.list({ createdBefore: bAt, sortBy: 'createdAt', sortDirection: 'asc' })
    expect(upToB.map((r) => r.id)).toEqual([a.id, b.id])
  })

  it('sorts by importance ascending and descending', async () => {
    await memory.store({ content: 'low', importance: 0.2 })
    await memory.store({ content: 'high', importance: 0.9 })
    await memory.store({ content: 'mid', importance: 0.5 })
    const asc = await memory.list({ sortBy: 'importance', sortDirection: 'asc' })
    expect(asc.map((r) => r.content)).toEqual(['low', 'mid', 'high'])
    const desc = await memory.list({ sortBy: 'importance', sortDirection: 'desc' })
    expect(desc.map((r) => r.content)).toEqual(['high', 'mid', 'low'])
  })

  it('pages with limit and offset', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await memory.store({ content: `m${i}` })).id)
    const page = await memory.list({ sortBy: 'createdAt', sortDirection: 'asc', limit: 2, offset: 1 })
    expect(page.map((r) => r.id)).toEqual([ids[1], ids[2]])
  })

  it('excludes soft-deleted by default; includeDeleted surfaces them', async () => {
    const a = await memory.store({ content: 'keep' })
    const b = await memory.store({ content: 'remove' })
    await memory.delete(b.id)
    const live = await memory.list()
    expect(live.map((r) => r.id)).toEqual([a.id])
    const all = await memory.list({ includeDeleted: true })
    expect(new Set(all.map((r) => r.id))).toEqual(new Set([a.id, b.id]))
  })

  it('combines filters (type + tag + importance)', async () => {
    await memory.store({ content: 'match', type: 'note', tags: ['keep'], importance: 0.7 })
    await memory.store({ content: 'wrong type', type: 'decision', tags: ['keep'], importance: 0.7 })
    await memory.store({ content: 'wrong tag', type: 'note', tags: ['other'], importance: 0.7 })
    await memory.store({ content: 'too low', type: 'note', tags: ['keep'], importance: 0.1 })
    const rows = await memory.list({ type: 'note', tags: ['keep'], minImportance: 0.5 })
    expect(rows.map((r) => r.content)).toEqual(['match'])
  })
})
