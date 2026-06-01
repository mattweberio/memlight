/**
 * memlight — embedded vector memory for Akemi agents.
 *
 * Public API:
 *
 *   import { createMemoryProvider } from 'memlight';
 *
 *   const memory = await createMemoryProvider({
 *     dataDir: '/home/you/.local/share/akemi/memory',
 *     embed: async (text) => myEmbedder(text),
 *   });
 *
 *   await memory.store({ content: '...', tags: ['scope:agent:echo'] });
 *   const hits = await memory.recall({ query: 'what did I say about X?' });
 *
 * See README.md for design rationale.
 */

export {
  createMemoryProvider,
  readSchemaVersion,
  MEMLIGHT_SCHEMA_VERSION,
} from './provider.js';
export type {
  MemoryProvider,
  MemoryProviderConfig,
  MemoryRecord,
  MemoryEdge,
  StoreInput,
  RecallQuery,
  Embedder,
} from './types.js';
