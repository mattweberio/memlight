/**
 * memlight persistence + schema migration tests.
 *
 * The original test suite uses `memory://` PGlite, which is fine for
 * happy-path CRUD but can't catch persistence bugs (everything's
 * thrown away at process end). This file uses a real on-disk
 * dataDir per test and verifies:
 *
 *   1. Stored memories survive close() + reopen.
 *   2. Schema version is recorded on first init.
 *   3. Re-init on an existing dataDir is idempotent and doesn't
 *      re-run migrations.
 *   4. The schema_version table starts at the current shipped version.
 *
 * Each test uses its own tmp dir + cleans up. PGlite cold start is
 * a few seconds per test so the suite is slow but real.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import {
  createMemoryProvider,
  readSchemaVersion,
  MEMLIGHT_SCHEMA_VERSION,
} from '../src/index.js';
import type { Embedder } from '../src/index.js';

const DIM = 8;
const fakeEmbedder: Embedder = async (text: string): Promise<number[]> => {
  const vec = new Array<number>(DIM).fill(0);
  for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
    vec[h % DIM]! += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'memlight-persist-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('persistence', () => {
  it('stored memories survive close + reopen', async () => {
    // First boot: write data, close.
    const m1 = await createMemoryProvider({
      dataDir: tmpDir,
      embed: fakeEmbedder,
      vectorDim: DIM,
    });
    const stored = await m1.store({
      content: 'persistent memory across boots',
      tags: ['persistence-test'],
      importance: 0.7,
    });
    expect(await m1.count()).toBe(1);
    await m1.close();

    // Second boot: same dataDir, fresh provider instance.
    const m2 = await createMemoryProvider({
      dataDir: tmpDir,
      embed: fakeEmbedder,
      vectorDim: DIM,
    });
    try {
      expect(await m2.count()).toBe(1);
      const got = await m2.get(stored.id);
      expect(got).toBeDefined();
      expect(got?.content).toBe('persistent memory across boots');
      expect(got?.tags).toContain('persistence-test');
      expect(got?.importance).toBeCloseTo(0.7, 5);
    } finally {
      await m2.close();
    }
  }, 60_000);

  it('recall finds memories written in a previous session', async () => {
    const m1 = await createMemoryProvider({
      dataDir: tmpDir,
      embed: fakeEmbedder,
      vectorDim: DIM,
    });
    await m1.store({ content: 'alpha bravo charlie', tags: ['set-a'] });
    await m1.store({ content: 'delta echo foxtrot', tags: ['set-a'] });
    await m1.close();

    const m2 = await createMemoryProvider({
      dataDir: tmpDir,
      embed: fakeEmbedder,
      vectorDim: DIM,
    });
    try {
      const hits = await m2.recall({ query: 'alpha bravo', tags: ['set-a'] });
      expect(hits.length).toBe(2);
      // Token-overlap should put alpha-bravo first.
      expect(hits[0]?.content).toContain('alpha');
    } finally {
      await m2.close();
    }
  }, 60_000);

  it('edges persist across reopen', async () => {
    const m1 = await createMemoryProvider({
      dataDir: tmpDir,
      embed: fakeEmbedder,
      vectorDim: DIM,
    });
    const a = await m1.store({ content: 'a' });
    const b = await m1.store({ content: 'b' });
    await m1.associate(a.id, b.id, 'connects-to', 0.9);
    await m1.close();

    const m2 = await createMemoryProvider({
      dataDir: tmpDir,
      embed: fakeEmbedder,
      vectorDim: DIM,
    });
    try {
      const edges = await m2.neighbors(a.id);
      expect(edges.length).toBe(1);
      expect(edges[0]?.toId).toBe(b.id);
      expect(edges[0]?.relation).toBe('connects-to');
      expect(edges[0]?.strength).toBeCloseTo(0.9, 5);
    } finally {
      await m2.close();
    }
  }, 60_000);
});

describe('schema migrations', () => {
  it('records the current schema version on first init', async () => {
    const m = await createMemoryProvider({
      dataDir: tmpDir,
      embed: fakeEmbedder,
      vectorDim: DIM,
    });
    try {
      // Read the version directly via a sibling PGlite handle so we
      // verify the data is on disk, not just in the closure state.
      // (We need a separate handle because the provider's pg is private.)
      // Instead, read it after close+reopen.
    } finally {
      await m.close();
    }

    const pg = await PGlite.create({ dataDir: tmpDir, extensions: { vector } });
    try {
      const version = await readSchemaVersion(pg);
      expect(version).toBe(MEMLIGHT_SCHEMA_VERSION);
      expect(version).toBeGreaterThanOrEqual(1);
    } finally {
      await pg.close();
    }
  }, 60_000);

  it('reading version on a fresh dataDir returns 0 before init', async () => {
    // Open PGlite directly without going through createMemoryProvider —
    // so the schema_version table doesn't exist yet.
    const pg = await PGlite.create({ dataDir: tmpDir, extensions: { vector } });
    try {
      const version = await readSchemaVersion(pg);
      expect(version).toBe(0);
    } finally {
      await pg.close();
    }
  }, 60_000);

  it('re-init on an existing dataDir is idempotent', async () => {
    // Boot once, write data, close.
    const m1 = await createMemoryProvider({
      dataDir: tmpDir,
      embed: fakeEmbedder,
      vectorDim: DIM,
    });
    await m1.store({ content: 'before reinit' });
    expect(await m1.count()).toBe(1);
    await m1.close();

    // Boot a SECOND time on the same dataDir. The migration runner
    // should see the existing version and skip.
    const m2 = await createMemoryProvider({
      dataDir: tmpDir,
      embed: fakeEmbedder,
      vectorDim: DIM,
    });
    try {
      // Existing data is intact.
      expect(await m2.count()).toBe(1);
      // Can still write new data.
      await m2.store({ content: 'after reinit' });
      expect(await m2.count()).toBe(2);
    } finally {
      await m2.close();
    }

    // Verify schema_version still has exactly one row (no duplicate
    // entries from re-running).
    const pg = await PGlite.create({ dataDir: tmpDir, extensions: { vector } });
    try {
      const result = await pg.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM memlight_schema_version`,
      );
      expect(result.rows[0]?.count).toBe(MEMLIGHT_SCHEMA_VERSION);
    } finally {
      await pg.close();
    }
  }, 90_000);

  it('records a description for each applied migration', async () => {
    const m = await createMemoryProvider({
      dataDir: tmpDir,
      embed: fakeEmbedder,
      vectorDim: DIM,
    });
    await m.close();

    const pg = await PGlite.create({ dataDir: tmpDir, extensions: { vector } });
    try {
      const result = await pg.query<{ version: number; description: string }>(
        `SELECT version, description FROM memlight_schema_version ORDER BY version`,
      );
      expect(result.rows.length).toBe(MEMLIGHT_SCHEMA_VERSION);
      expect(result.rows[0]?.description).toMatch(/initial schema/i);
    } finally {
      await pg.close();
    }
  }, 60_000);

  it('exports MEMLIGHT_SCHEMA_VERSION as a positive integer', () => {
    expect(typeof MEMLIGHT_SCHEMA_VERSION).toBe('number');
    expect(MEMLIGHT_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(MEMLIGHT_SCHEMA_VERSION)).toBe(true);
  });
});

describe('edge cases', () => {
  it('get on unknown id returns null', async () => {
    const m = await createMemoryProvider({ dataDir: tmpDir, vectorDim: DIM });
    try {
      const got = await m.get('00000000-0000-0000-0000-000000000000');
      expect(got).toBeNull();
    } finally {
      await m.close();
    }
  }, 30_000);

  it('delete on unknown id returns false', async () => {
    const m = await createMemoryProvider({ dataDir: tmpDir, vectorDim: DIM });
    try {
      const ok = await m.delete('00000000-0000-0000-0000-000000000000');
      expect(ok).toBe(false);
    } finally {
      await m.close();
    }
  }, 30_000);

  it('multi-tag recall returns only memories with ALL requested tags (AND semantics)', async () => {
    const m = await createMemoryProvider({ dataDir: tmpDir, vectorDim: DIM });
    try {
      await m.store({ content: 'has both', tags: ['a', 'b'] });
      await m.store({ content: 'only a', tags: ['a'] });
      await m.store({ content: 'only b', tags: ['b'] });
      await m.store({ content: 'has both plus more', tags: ['a', 'b', 'c'] });

      const hits = await m.recall({ tags: ['a', 'b'] });
      expect(hits.length).toBe(2);
      const contents = hits.map((h) => h.content);
      expect(contents).toContain('has both');
      expect(contents).toContain('has both plus more');
      expect(contents).not.toContain('only a');
      expect(contents).not.toContain('only b');
    } finally {
      await m.close();
    }
  }, 30_000);

  it('zero-length embedding falls back to tag-only path silently', async () => {
    const zeroEmbedder: Embedder = async () => [];
    const m = await createMemoryProvider({
      dataDir: tmpDir,
      embed: zeroEmbedder,
      vectorDim: DIM,
    });
    try {
      // Store should not crash on a zero-length embedding.
      const stored = await m.store({ content: 'tag only', tags: ['empty-vec'] });
      expect(stored.id).toBeDefined();
      // Recall with a query should fall back to tag-only path.
      const hits = await m.recall({ query: 'anything', tags: ['empty-vec'] });
      expect(hits.length).toBe(1);
    } finally {
      await m.close();
    }
  }, 30_000);

  it('tag exact-match prevents prefix collisions across scopes', async () => {
    // The MemlightAdapter scope-prefix model relies on `tags @>`
    // doing exact element matching, NOT prefix matching. If pgvector's
    // jsonb containment ever started doing prefix match, every scope
    // would leak memories from sibling scopes. Lock the contract here.
    const m = await createMemoryProvider({ dataDir: tmpDir, vectorDim: DIM });
    try {
      await m.store({ content: 'echo memory', tags: ['scope:agent:echo'] });
      await m.store({ content: 'echo2 memory', tags: ['scope:agent:echo2'] });

      const echoHits = await m.recall({ tags: ['scope:agent:echo'] });
      expect(echoHits.length).toBe(1);
      expect(echoHits[0]?.content).toBe('echo memory');

      const echo2Hits = await m.recall({ tags: ['scope:agent:echo2'] });
      expect(echo2Hits.length).toBe(1);
      expect(echo2Hits[0]?.content).toBe('echo2 memory');
    } finally {
      await m.close();
    }
  }, 30_000);
});
