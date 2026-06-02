/**
 * memlight: embedded vector memory for AI agents.
 *
 * Zero config: the bundled embedder and OS app-data storage mean a
 * working memory in two lines.
 *
 *   import { createMemoryProvider } from 'memlight'
 *
 *   const memory = await createMemoryProvider()
 *   await memory.store({ content: 'Matt prefers concise answers', tags: ['preference'] })
 *   const hits = await memory.recall({ query: 'how does Matt like answers' })
 *
 * See README.md for the full API and design notes.
 */

export {
  createMemoryProvider,
  readSchemaVersion,
  MEMLIGHT_SCHEMA_VERSION,
} from './provider.js'
export {
  createDefaultEmbedder,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_VECTOR_DIM,
} from './embedder.js'
export { osDataRoot, resolveDataDir, modelCacheDir, IN_MEMORY } from './paths.js'
export { DEFAULT_SEARCH_WEIGHTS } from './types.js'
export type {
  MemoryProvider,
  MemoryProviderConfig,
  MemoryRecord,
  MemoryEdge,
  StoreInput,
  StoreOptions,
  StoreResult,
  UpdateInput,
  DeleteOptions,
  DuplicateCheck,
  RecallQuery,
  ListFilter,
  StructuredFilter,
  SearchWeights,
  Embedder,
} from './types.js'
