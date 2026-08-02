// Pre-download the embedding model into the image at build time, so the running
// container never needs to reach the network for weights.
import { pipeline, env } from '@xenova/transformers';

env.cacheDir = process.env.EMBEDDINGS_CACHE_DIR || './models';
env.allowRemoteModels = true;

const model = process.env.EMBEDDINGS_MODEL || 'Xenova/all-MiniLM-L6-v2';
console.log(`Fetching ${model} → ${env.cacheDir}`);
const t0 = Date.now();
await pipeline('feature-extraction', model);
console.log(`Model cached in ${Date.now() - t0} ms`);
