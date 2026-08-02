// Companion GitHub repositories: detect repo links in article bodies (restricted to
// an owner allowlist), fetch the README (raw, no token needed), optionally enrich with
// repo metadata. READMEs are cached with a long TTL so index rebuilds don't refetch.

export interface RepoRef { owner: string; name: string }
export interface RepoDoc {
  owner: string;
  name: string;
  url: string;
  readme: string;
  description: string;
  topics: string[];
  stars: number | null;
}

// github.com paths that are not repositories
const NON_REPO_OWNERS = new Set([
  'sponsors', 'orgs', 'topics', 'features', 'about', 'pricing', 'marketplace',
  'settings', 'notifications', 'explore', 'search', 'apps', 'login', 'join',
]);
const NON_REPO_NAMES = new Set(['blob', 'tree', 'releases', 'issues', 'pull', 'wiki', 'actions']);

/** Extract unique repo refs from HTML, keeping only owners in `owners` (case-insensitive). */
export function extractRepos(html: string, owners: string[]): RepoRef[] {
  const allow = new Set(owners.map((o) => o.toLowerCase()));
  // Companion repos are opt-in: with no owner allowlist the feature is OFF (index none),
  // rather than indexing every third-party repo an article happens to link.
  if (allow.size === 0) return [];
  const re = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;
  const seen = new Set<string>();
  const out: RepoRef[] = [];
  for (const m of html.matchAll(re)) {
    const owner = m[1];
    const name = m[2].replace(/\.git$/i, '');
    if (NON_REPO_OWNERS.has(owner.toLowerCase()) || NON_REPO_NAMES.has(name.toLowerCase())) continue;
    if (allow.size && !allow.has(owner.toLowerCase())) continue;
    const key = `${owner}/${name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner, name });
  }
  return out;
}

interface CacheEntry { at: number; doc: RepoDoc | null }
const cache = new Map<string, CacheEntry>();
const README_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function authHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': 'ghost-content-mcp' };
  if (token) h.Authorization = `token ${token}`;
  return h;
}

async function fetchText(url: string, headers: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchReadme(owner: string, name: string, token?: string): Promise<string | null> {
  for (const branch of ['main', 'master']) {
    const t = await fetchText(
      `https://raw.githubusercontent.com/${owner}/${name}/${branch}/README.md`,
      authHeaders(token),
    );
    if (t) return t;
  }
  // fallback: default-branch readme (any filename) via API
  return fetchText(`https://api.github.com/repos/${owner}/${name}/readme`, {
    ...authHeaders(token),
    Accept: 'application/vnd.github.raw',
  });
}

async function fetchMeta(owner: string, name: string, token?: string): Promise<Partial<RepoDoc>> {
  const raw = await fetchText(`https://api.github.com/repos/${owner}/${name}`, {
    ...authHeaders(token),
    Accept: 'application/vnd.github+json',
  });
  if (!raw) return {};
  try {
    const j = JSON.parse(raw);
    return {
      description: (j.description ?? '').trim(),
      topics: Array.isArray(j.topics) ? j.topics : [],
      stars: typeof j.stargazers_count === 'number' ? j.stargazers_count : null,
    };
  } catch {
    return {};
  }
}

/** Fetch one repo's README (+metadata), cached. Returns null if no README is reachable. */
export async function fetchRepo(owner: string, name: string, token?: string): Promise<RepoDoc | null> {
  const key = `${owner}/${name}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < README_TTL_MS) return hit.doc;

  const readme = await fetchReadme(owner, name, token);
  let doc: RepoDoc | null = null;
  if (readme) {
    const meta = await fetchMeta(owner, name, token);
    doc = {
      owner, name,
      url: `https://github.com/${owner}/${name}`,
      readme,
      description: meta.description ?? '',
      topics: meta.topics ?? [],
      stars: meta.stars ?? null,
    };
  }
  cache.set(key, { at: Date.now(), doc });
  return doc;
}

/** Resolve many repos with limited concurrency. */
export async function fetchRepos(refs: RepoRef[], token?: string, concurrency = 4): Promise<RepoDoc[]> {
  const out: RepoDoc[] = [];
  let i = 0;
  async function worker() {
    while (i < refs.length) {
      const ref = refs[i++];
      const doc = await fetchRepo(ref.owner, ref.name, token);
      if (doc) out.push(doc);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, refs.length) }, worker));
  return out;
}

/** Test seam. */
export function _clearRepoCache(): void { cache.clear(); }
