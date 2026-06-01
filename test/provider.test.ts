/**
 * memlight provider tests.
 *
 * Exercises the full surface against an in-memory PGlite (passing
 * `memory://` as dataDir). No network, no filesystem. The pgvector
 * extension loads from the @electric-sql/pglite bundle.
 *
 * Uses a deterministic fake embedder that hashes tokens into a
 * fixed-dim vector — good enough for similarity ranking tests
 * without pulling in a real model.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryProvider } from '../src/index.js';
import type { Embedder, MemoryProvider } from '../src/index.js';

const DIM = 8;

/** Deterministic fake embedder. Token-hash to fixed bucket positions
 *  then L2-normalize. Texts with overlapping tokens get higher cosine
 *  similarity than unrelated texts — sufficient for ranking tests. */
const fakeEmbedder: Embedder = async (text: string): Promise<number[]> => {
  const vec = new Array<number>(DIM).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const tok of tokens) {
    let hash = 0;
    for (let i = 0; i < tok.length; i++) hash = (hash * 31 + tok.charCodeAt(i)) >>> 0;
    vec[hash % DIM]! += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
};

describe('memlight', () => {
  let memory: MemoryProvider;

  beforeEach(async () => {
    memory = await createMemoryProvider({
      dataDir: 'memory://',
      embed: fakeEmbedder,
      vectorDim: DIM,
    });
  });

  afterEach(async () => {
    await memory.close();
  });

  it('stores and retrieves a memory by id', async () => {
    const { id } = await memory.store({
      content: 'the product plan for akemi v2 lives in docs/plans',
      tags: ['plan', 'v2'],
      importance: 0.9,
      type: 'Context',
    });
    expect(id).toBeTruthy();
    const got = await memory.get(id);
    expect(got?.content).toContain('product plan');
    expect(got?.tags).toEqual(['plan', 'v2']);
    expect(got?.importance).toBeCloseTo(0.9, 5);
  });

  it('rejects empty content', async () => {
    await expect(memory.store({ content: '   ' })).rejects.toThrow(/content/);
  });

  it('recalls with token-overlap ranking (vector path)', async () => {
    // The fake embedder hashes tokens into fixed buckets, so content
    // that shares more tokens with the query gets a higher cosine
    // similarity. This tests that the vector pipeline round-trips
    // and orders correctly, not that embeddings are semantically
    // smart — that's the caller's embedder's job.
    await memory.store({ content: 'alpha bravo charlie delta' });
    await memory.store({ content: 'zulu yankee xray whiskey' });
    await memory.store({ content: 'alpha bravo echo foxtrot' });

    const hits = await memory.recall({ query: 'alpha bravo', limit: 3 });
    expect(hits.length).toBe(3);
    // Top two hits must share tokens with "alpha bravo"; the zulu
    // one must be last.
    const last = hits[hits.length - 1];
    expect(last?.content).toContain('zulu');
    for (const h of hits) expect(h.score).toBeDefined();
  });

  it('filters by tags on the vector path', async () => {
    await memory.store({ content: 'note one', tags: ['scope:agent:echo'] });
    await memory.store({ content: 'note two', tags: ['scope:agent:writer'] });
    await memory.store({ content: 'note three', tags: ['scope:agent:echo'] });

    const hits = await memory.recall({
      query: 'note',
      tags: ['scope:agent:echo'],
      limit: 10,
    });
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.tags.includes('scope:agent:echo'))).toBe(true);
  });

  it('falls back to tag-only when no embedder is provided', async () => {
    const tagOnlyMemory = await createMemoryProvider({
      dataDir: 'memory://',
      vectorDim: DIM,
    });
    try {
      await tagOnlyMemory.store({ content: 'a', tags: ['x'] });
      await tagOnlyMemory.store({ content: 'b', tags: ['x'] });
      await tagOnlyMemory.store({ content: 'c', tags: ['y'] });
      const hits = await tagOnlyMemory.recall({ tags: ['x'] });
      expect(hits.length).toBe(2);
    } finally {
      await tagOnlyMemory.close();
    }
  });

  it('deletes a memory', async () => {
    const { id } = await memory.store({ content: 'ephemeral' });
    const ok = await memory.delete(id);
    expect(ok).toBe(true);
    const gone = await memory.get(id);
    expect(gone).toBeNull();
  });

  it('creates and lists edges', async () => {
    const a = await memory.store({ content: 'goal: ship v2' });
    const b = await memory.store({ content: 'blocker: finish DAL tests' });
    const edge = await memory.associate(a.id, b.id, 'blocked_by', 0.8);
    expect(edge.fromId).toBe(a.id);
    expect(edge.toId).toBe(b.id);
    expect(edge.relation).toBe('blocked_by');
    expect(edge.strength).toBeCloseTo(0.8, 5);

    const neighbors = await memory.neighbors(a.id);
    expect(neighbors.length).toBe(1);
    expect(neighbors[0]?.toId).toBe(b.id);
  });

  it('cascades edge deletion when a memory is removed', async () => {
    const a = await memory.store({ content: 'x' });
    const b = await memory.store({ content: 'y' });
    await memory.associate(a.id, b.id, 'relates_to');
    await memory.delete(a.id);
    const remaining = await memory.neighbors(b.id);
    expect(remaining.length).toBe(0);
  });

  it('counts stored memories', async () => {
    expect(await memory.count()).toBe(0);
    await memory.store({ content: 'one' });
    await memory.store({ content: 'two' });
    expect(await memory.count()).toBe(2);
  });

  it('upsert on id overwrites previous content', async () => {
    const id = 'stable-id';
    await memory.store({ id, content: 'original' });
    await memory.store({ id, content: 'updated' });
    const got = await memory.get(id);
    expect(got?.content).toBe('updated');
  });
});
