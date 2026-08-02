import { createApp } from './app.js';
import { IndexStore } from './store.js';
import { resolveSiteInfo } from './config.js';

const key = process.env.GHOST_CONTENT_API_KEY;
if (!key) {
  console.error('GHOST_CONTENT_API_KEY is required');
  process.exit(1);
}

const cfg = {
  url: process.env.GHOST_URL ?? 'http://localhost:2368',
  key,
};
const port = Number(process.env.PORT ?? 3000);
// Companion GitHub repos are opt-in: only enabled when GITHUB_COMPANION_OWNERS lists owners.
const owners = (process.env.GITHUB_COMPANION_OWNERS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Defensive: never let a stray async error take down the long-running server.
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

async function main() {
  // Auto-configure the site's identity from Ghost's own /settings (env can override).
  const site = await resolveSiteInfo(cfg);

  const store = new IndexStore(cfg, {
    ttlMs: process.env.INDEX_TTL_MS ? Number(process.env.INDEX_TTL_MS) : undefined,
    owners,
    githubToken: process.env.GITHUB_TOKEN,
    site,
  });

  createApp(cfg, store, { owners, site }).listen(port, () => {
    console.log(`ghost-content-mcp listening on :${port} — site: ${site.name}` +
      ` (companion owners: ${owners.join(', ') || 'none'})`);
    // Warm the index in the background so the first search is fast. Health stays up meanwhile.
    store.ensureReady()
      .then(() => console.log('index ready:', JSON.stringify(store.stats())))
      .catch((err) => console.error('initial index build failed (will retry on first search):', err.message));
  });
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
