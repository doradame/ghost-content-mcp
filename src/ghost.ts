export interface GhostConfig { url: string; key: string; timeoutMs?: number }

export class GhostError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GhostError';
    this.status = status;
  }
}

export interface PostSummary {
  title: string; slug: string; excerpt: string;
  tags: string[]; published_at: string | null; url: string;
}
export interface PostFull extends PostSummary { html: string }
export interface Pagination { page: number; pages: number; total: number }
export interface TagInfo { name: string; slug: string; description: string; count: number }

/** The site's public identity, read from Ghost's own Content API `/settings/`. */
export interface SiteSettings { title: string; description: string; url: string; lang: string }

/** A fully-loaded content item (post or page) used to build the search index. */
export interface FullDoc {
  type: 'post' | 'page';
  title: string; slug: string; url: string;
  tags: string[]; published_at: string | null;
  excerpt: string; text: string; html: string;
  /** tagged "#noindex": excluded from MCP discovery search (still fetchable by direct slug).
      Deliberately distinct from the site's "#hide" tag, which only hides from the blog feed —
      e.g. the games are "#hide" (out of the feed) but stay discoverable by the assistant. */
  hidden: boolean;
}

export type SortOrder = 'date_desc' | 'date_asc' | 'title';
export interface ListOpts { page?: number; limit?: number; tag?: string; since?: string; sort?: SortOrder }

interface RawPost {
  title: string; slug: string;
  excerpt?: string; custom_excerpt?: string;
  plaintext?: string;
  html?: string; published_at?: string | null; url?: string;
  tags?: { name: string; slug: string }[];
}

function ghostOrder(sort?: SortOrder): string {
  switch (sort) {
    case 'date_asc': return 'published_at asc';
    case 'title': return 'title asc';
    default: return 'published_at desc';
  }
}

async function ghostGet(
  cfg: GhostConfig, resource: string, params: Record<string, string>,
): Promise<any> {
  const url = new URL(`/ghost/api/content/${resource}/`, cfg.url);
  url.searchParams.set('key', cfg.key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { 'Accept-Version': 'v6.0' },
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new GhostError(`Ghost is unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    let message = `Ghost API error (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body?.errors?.[0]?.message) message = body.errors[0].message;
    } catch { /* non-JSON error body */ }
    throw new GhostError(message, res.status);
  }
  return res.json();
}

// Ghost internal tags (e.g. "#hide", "#noindex") start with "#"; never expose them publicly.
const isInternalTag = (name: string) => name.startsWith('#');

// Content carrying this tag is kept OUT of the discovery index (still fetchable by direct
// slug). Separate from the site's "#hide" (blog-feed hiding only) so blog-hidden-but-worth-
// surfacing content (the games) stays discoverable while true placeholders/dupes are opted out.
const NOINDEX_TAG = '#noindex';

function mapPost(p: RawPost): PostFull {
  return {
    title: p.title,
    slug: p.slug,
    excerpt: (p.custom_excerpt ?? p.excerpt ?? '').trim(),
    tags: (p.tags ?? []).map((t) => t.name).filter((n) => !isInternalTag(n)),
    published_at: p.published_at ?? null,
    url: p.url ?? '',
    html: p.html ?? '',
  };
}

function mapPagination(meta: any): Pagination {
  const p = meta?.pagination ?? {};
  return { page: p.page ?? 1, pages: p.pages ?? 1, total: p.total ?? 0 };
}

async function listResource(
  cfg: GhostConfig, resource: 'posts' | 'pages',
  opts: ListOpts = {},
): Promise<{ posts: PostSummary[]; pagination: Pagination }> {
  const params: Record<string, string> = {
    include: 'tags',
    fields: 'title,slug,custom_excerpt,excerpt,published_at,url',
    page: String(opts.page ?? 1),
    limit: String(opts.limit ?? 10),
    order: ghostOrder(opts.sort),
  };
  const filters: string[] = [];
  if (opts.tag) filters.push(`tag:${opts.tag}`);
  if (opts.since && /^\d{4}-\d{2}-\d{2}$/.test(opts.since)) filters.push(`published_at:>='${opts.since} 00:00:00'`);
  if (filters.length) params.filter = filters.join('+');
  const body = await ghostGet(cfg, resource, params);
  return {
    posts: (body[resource] ?? []).map(mapPost),
    pagination: mapPagination(body.meta),
  };
}

/** Fetch every published post and page with plaintext + html, for the search index. */
export async function fetchAllContent(cfg: GhostConfig): Promise<FullDoc[]> {
  const load = async (resource: 'posts' | 'pages'): Promise<FullDoc[]> => {
    const body = await ghostGet(cfg, resource, {
      include: 'tags',
      formats: 'plaintext,html',
      fields: 'title,slug,url,published_at,custom_excerpt,excerpt,plaintext,html',
      limit: 'all',
      order: 'published_at desc',
    });
    return (body[resource] ?? []).map((p: RawPost) => {
      const m = mapPost(p);
      return {
        type: resource === 'posts' ? 'post' as const : 'page' as const,
        title: m.title, slug: m.slug, url: m.url,
        tags: m.tags, published_at: m.published_at,
        excerpt: m.excerpt,
        text: (p.plaintext ?? '').trim(),
        html: m.html,
        hidden: (p.tags ?? []).some((t) => (t.name ?? '').toLowerCase() === NOINDEX_TAG),
      };
    });
  };
  const [posts, pages] = await Promise.all([load('posts'), load('pages')]);
  return [...posts, ...pages];
}

async function getBySlug(
  cfg: GhostConfig, resource: 'posts' | 'pages', slug: string,
): Promise<PostFull> {
  const kind = resource === 'posts' ? 'Post' : 'Page';
  let body: any;
  try {
    body = await ghostGet(cfg, `${resource}/slug/${encodeURIComponent(slug)}`, { include: 'tags' });
  } catch (err) {
    if (err instanceof GhostError && err.status === 404) {
      throw new GhostError(`${kind} not found: ${slug}`, 404);
    }
    throw err;
  }
  const item = body[resource]?.[0];
  if (!item) throw new GhostError(`${kind} not found: ${slug}`, 404);
  return mapPost(item);
}

export const listPosts = (cfg: GhostConfig, opts?: ListOpts) =>
  listResource(cfg, 'posts', opts);
export const getPost = (cfg: GhostConfig, slug: string) => getBySlug(cfg, 'posts', slug);
export const listPages = (cfg: GhostConfig, opts?: Omit<ListOpts, 'tag'>) =>
  listResource(cfg, 'pages', opts);
export const getPage = (cfg: GhostConfig, slug: string) => getBySlug(cfg, 'pages', slug);

export async function searchPosts(
  cfg: GhostConfig, query: string, limit = 10,
): Promise<PostSummary[]> {
  const q = query.replace(/['\\]/g, '').slice(0, 100).trim();
  if (!q) return [];
  const body = await ghostGet(cfg, 'posts', {
    include: 'tags',
    fields: 'title,slug,custom_excerpt,excerpt,published_at,url',
    limit: String(limit),
    filter: `title:~'${q}',plaintext:~'${q}'`,
  });
  return (body.posts ?? []).map(mapPost);
}

/** Read the site's public identity (title, description, url, lang) straight from Ghost.
 *  Lets the server auto-configure for any Ghost instance with zero extra config. */
export async function fetchSettings(cfg: GhostConfig): Promise<SiteSettings> {
  const body = await ghostGet(cfg, 'settings', {});
  const s = body.settings ?? {};
  return {
    title: (s.title ?? '').trim(),
    description: (s.description ?? '').trim(),
    url: (s.url ?? cfg.url ?? '').replace(/\/+$/, ''),
    lang: s.lang ?? 'en',
  };
}

export async function listTags(cfg: GhostConfig): Promise<TagInfo[]> {
  const body = await ghostGet(cfg, 'tags', { include: 'count.posts', limit: 'all' });
  return (body.tags ?? [])
    .filter((t: any) => !isInternalTag(t.name ?? ''))
    .map((t: any) => ({
      name: t.name, slug: t.slug,
      description: t.description ?? '',
      count: t.count?.posts ?? 0,
    }));
}
