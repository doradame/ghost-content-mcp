import { pipeline, env } from '@xenova/transformers';

// Local, bundled model. In the container the weights live under EMBEDDINGS_CACHE_DIR
// (populated at image-build time), so no network fetch happens at runtime.
env.cacheDir = process.env.EMBEDDINGS_CACHE_DIR ?? '/app/models';
env.allowLocalModels = true;
env.allowRemoteModels = process.env.EMBEDDINGS_ALLOW_REMOTE === '1';

const MODEL = process.env.EMBEDDINGS_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
const MAX_CHARS = 2000; // MiniLM truncates ~256 tokens anyway; cap input work
// Embed in small chunks: a single 39-doc call makes onnxruntime grow (and retain) a large
// arena → high peak + high steady-state RSS. Small batches keep the transient allocation
// bounded, which on a swap-light host is the difference between a clean build and a native
// abort. Tunable via EMBEDDINGS_BATCH_SIZE.
const BATCH_SIZE = Math.max(1, Number(process.env.EMBEDDINGS_BATCH_SIZE ?? 8));

type Extractor = (input: string | string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array; dims: number[] }>;
let pipePromise: Promise<Extractor> | null = null;

function getPipe(): Promise<Extractor> {
  return (pipePromise ??= pipeline('feature-extraction', MODEL) as unknown as Promise<Extractor>);
}

/** Embed a batch of texts → array of L2-normalized vectors. Processed in small chunks so
 * the native arena stays bounded regardless of how many docs are indexed. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipe = await getPipe();
  const out: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const chunk = texts.slice(start, start + BATCH_SIZE).map((t) => (t || ' ').slice(0, MAX_CHARS));
    const res = await pipe(chunk, { pooling: 'mean', normalize: true });
    const dim = res.dims[res.dims.length - 1];
    for (let i = 0; i < chunk.length; i++) {
      out.push(res.data.slice(i * dim, (i + 1) * dim));
    }
  }
  return out;
}

export async function embedOne(text: string): Promise<Float32Array> {
  return (await embed([text]))[0];
}

/** Warm the pipeline (loads the model once). */
export async function warmup(): Promise<void> {
  await getPipe();
}
