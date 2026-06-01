/**
 * Bundled default embedder.
 *
 * memlight works with zero configuration: if you do not supply your
 * own embedder, it uses a local model that runs in-process with no
 * API key and no network at query time (the model is downloaded once
 * to a shared cache on first use).
 *
 * Model: Xenova/bge-small-en-v1.5, 384 dimensions, run through
 * transformers.js with mean pooling and L2 normalization, so the
 * output is unit-norm and ready for cosine similarity.
 *
 * The transformers.js dependency is loaded lazily the first time the
 * default embedder runs, so apps that pass their own embedder never
 * pay for it.
 */

import { modelCacheDir } from './paths.js'
import type { Embedder } from './types.js'

/** The bundled model. Swap by passing your own embedder instead. */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5'

/** Output dimension of {@link DEFAULT_EMBEDDING_MODEL}. */
export const DEFAULT_VECTOR_DIM = 384

/** Minimal shape of the transformers.js feature-extraction pipeline. */
type FeatureExtractor = (
  text: string,
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>

let extractor: Promise<FeatureExtractor> | null = null

/** Load (once) and return the feature-extraction pipeline. */
function loadExtractor(): Promise<FeatureExtractor> {
  if (!extractor) {
    extractor = (async () => {
      const { env, pipeline } = await import('@huggingface/transformers')
      env.cacheDir = modelCacheDir()
      const pipe = await pipeline('feature-extraction', DEFAULT_EMBEDDING_MODEL, { dtype: 'q8' })
      return pipe as unknown as FeatureExtractor
    })()
  }
  return extractor
}

/**
 * Create the bundled default embedder. The returned function loads the
 * model on first call and reuses it after that.
 */
export function createDefaultEmbedder(): Embedder {
  return async (text: string): Promise<number[]> => {
    const extract = await loadExtractor()
    const output = await extract(text, { pooling: 'mean', normalize: true })
    return Array.from(output.data, Number)
  }
}
