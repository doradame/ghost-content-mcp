import { GhostConfig, FullDoc, TagInfo, fetchAllContent, listTags } from './ghost.js';
import { Bm25, Bm25Doc, tokenize, tagOverlap, cosine } from './ranking.js';
import { extractRepos, fetchRepos, RepoRef } from './github.js';
import { SiteInfo } from './config.js';

const DEFAULT_SITE: SiteInfo = { name: 'this Ghost site', description: '', url: '', lang: 'en' };

// The embeddings module pulls in transformers/onnxruntime; load it lazily so unit tests
// (which inject fake embedders) never touch the native ML stack.
const defaultEmbed = async (texts: string[]) => (await import('./embeddings.js')).embed(texts);
const defaultEmbedOne = async (text: string) => (await import('./embeddings.js')).embedOne(text);

export interface Doc {
  id: string;
  type: 'post' | 'page' | 'repo';
  title: string;
  slug: string;
  url: string;
  tags: string[];
  published_at: string | null;
  excerpt: string;
  text: string;
  vector: Float32Array;
  /** repo docs: the articles that link to this repo */
  articles?: Array<{ title: string; slug: string; url: string }>;
}

export interface SearchHit { doc: Doc; relevance: number }
export interface SearchOpts { limit?: number; type?: 'all' | 'posts' | 'pages' | 'repos'; since?: string }

export interface StoreOpts {
  ttlMs?: number;
  owners?: string[];
  githubToken?: string;
  site?: SiteInfo;
  // injectable for tests
  embed?: (texts: string[]) => Promise<Float32Array[]>;
  embedOne?: (text: string) => Promise<Float32Array>;
}

const LEX_WEIGHT = 0.5;
const SEM_WEIGHT = 0.5;
const MIN_RELEVANCE = 0.12;

function embeddingText(title: string, tags: string[], excerpt: string, text: string): string {
  return `${title}\n${tags.join(' ')}\n${excerpt}\n${text.slice(0, 1500)}`;
}

function bm25Tokens(title: string, tags: string[], text: string): string[] {
  const t = tokenize(title);
  const g = tokenize(tags.join(' '));
  const body = tokenize(text);
  return [...t, ...t, ...t, ...g, ...g, ...body]; // title ×3, tags ×2, body ×1
}

function truncate(s: string, len: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= len) return clean;
  const cut = clean.slice(0, len);
  const sp = cut.lastIndexOf(' ');
  return (sp > len * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

export class IndexStore {
  private docs: Doc[] = [];
  private bm25: Bm25 | null = null;
  private tags: TagInfo[] = [];
  private companions = new Map<string, string[]>(); // article slug → repo urls
  private builtAt = 0;
  private building: Promise<void> | null = null;

  private readonly ttlMs: number;
  private readonly owners: string[];
  private readonly githubToken?: string;
  private readonly site: SiteInfo;
  private readonly embed: (texts: string[]) => Promise<Float32Array[]>;
  private readonly embedOne: (text: string) => Promise<Float32Array>;

  constructor(private readonly cfg: GhostConfig, opts: StoreOpts = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.owners = opts.owners ?? [];
    this.githubToken = opts.githubToken;
    this.site = opts.site ?? DEFAULT_SITE;
    this.embed = opts.embed ?? defaultEmbed;
    this.embedOne = opts.embedOne ?? defaultEmbedOne;
  }

  private fresh(): boolean {
    return this.docs.length > 0 && Date.now() - this.builtAt < this.ttlMs;
  }

  /** Single-flight guarded rebuild; concurrent callers join the same build. */
  private rebuild(): Promise<void> {
    if (!this.building) {
      this.building = (async () => {
        try { await this.build(); }
        finally { this.building = null; }
      })();
    }
    return this.building;
  }

  /** Ensure a usable index exists; rebuild when stale. Safe to call concurrently. */
  async ensureReady(): Promise<void> {
    if (this.fresh()) return;
    const p = this.rebuild();
    if (this.docs.length === 0) { await p; return; } // cold start: must wait
    p.catch(() => {}); // serve stale while rebuilding; never leave the rejection unhandled
  }

  /** Force a rebuild on the next access (e.g. content was just published). */
  invalidate(): void { this.builtAt = 0; }

  /** Invalidate and (re)build now, joining any in-flight build. */
  async refresh(): Promise<void> {
    this.invalidate();
    await this.rebuild();
  }

  private async build(): Promise<void> {
    const [allContent, tags] = await Promise.all([
      fetchAllContent(this.cfg),
      listTags(this.cfg).catch(() => [] as TagInfo[]),
    ]);
    // "#noindex" content is kept out of discovery search (still reachable by direct slug via
    // get_post/get_page). The site's "#hide" tag (blog-feed only) does NOT exclude here.
    const content = allContent.filter((c) => !c.hidden);

    // companion repos: collect refs across posts (owner-filtered)
    const refSet = new Map<string, RepoRef>();
    const companions = new Map<string, string[]>();
    for (const c of content) {
      if (c.type !== 'post') continue;
      const refs = extractRepos(c.html, this.owners);
      if (refs.length) {
        companions.set(c.slug, refs.map((r) => `https://github.com/${r.owner}/${r.name}`));
        for (const r of refs) refSet.set(`${r.owner}/${r.name}`.toLowerCase(), r);
      }
    }
    const repoDocsRaw = await fetchRepos([...refSet.values()], this.githubToken).catch(() => []);

    // map repo → linking articles
    const repoToArticles = new Map<string, Array<{ title: string; slug: string; url: string }>>();
    for (const c of content) {
      if (c.type !== 'post') continue;
      for (const r of extractRepos(c.html, this.owners)) {
        const key = `${r.owner}/${r.name}`.toLowerCase();
        const arr = repoToArticles.get(key) ?? [];
        arr.push({ title: c.title, slug: c.slug, url: c.url });
        repoToArticles.set(key, arr);
      }
    }

    // assemble docs (pre-embedding)
    interface Pre { doc: Omit<Doc, 'vector'>; embedText: string; tokens: string[] }
    const pre: Pre[] = [];

    for (const c of content as FullDoc[]) {
      pre.push({
        doc: {
          id: `${c.type}:${c.slug}`, type: c.type,
          title: c.title, slug: c.slug, url: c.url,
          tags: c.tags, published_at: c.published_at,
          excerpt: c.excerpt || truncate(c.text, 200), text: c.text,
        },
        embedText: embeddingText(c.title, c.tags, c.excerpt, c.text),
        tokens: bm25Tokens(c.title, c.tags, c.text),
      });
    }
    for (const r of repoDocsRaw) {
      const key = `${r.owner}/${r.name}`.toLowerCase();
      const title = `${r.owner}/${r.name}`;
      const desc = r.description || truncate(r.readme, 200);
      pre.push({
        doc: {
          id: `repo:${key}`, type: 'repo',
          title, slug: key, url: r.url,
          tags: r.topics, published_at: null,
          excerpt: desc, text: r.readme,
          articles: repoToArticles.get(key) ?? [],
        },
        embedText: embeddingText(title, r.topics, desc, r.readme),
        tokens: bm25Tokens(title + ' ' + desc, r.topics, r.readme),
      });
    }

    const vectors = await this.embed(pre.map((p) => p.embedText));
    const docs: Doc[] = pre.map((p, i) => ({ ...p.doc, vector: vectors[i] }));
    const bm25Docs: Bm25Doc[] = pre.map((p) => ({ id: p.doc.id, tokens: p.tokens }));

    this.docs = docs;
    this.bm25 = new Bm25(bm25Docs);
    this.tags = tags;
    this.companions = companions;
    this.builtAt = Date.now();
  }

  companionsFor(slug: string): string[] {
    return this.companions.get(slug) ?? [];
  }

  async search(query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    await this.ensureReady();
    const limit = opts.limit ?? 10;
    const type = opts.type ?? 'all';
    const qTokens = tokenize(query);
    const lex = this.bm25?.score(qTokens) ?? new Map<string, number>();
    let maxLex = 0;
    for (const v of lex.values()) if (v > maxLex) maxLex = v;
    const qVec = await this.embedOne(query);

    const wanted = (d: Doc) =>
      (type === 'all' ||
        (type === 'posts' && d.type === 'post') ||
        (type === 'pages' && d.type === 'page') ||
        (type === 'repos' && d.type === 'repo')) &&
      (!opts.since || (d.published_at ?? '') >= `${opts.since}T00:00:00.000Z`);

    const hits: SearchHit[] = [];
    for (const d of this.docs) {
      if (!wanted(d)) continue;
      const lexNorm = maxLex > 0 ? (lex.get(d.id) ?? 0) / maxLex : 0;
      const sem = Math.max(0, cosine(qVec, d.vector));
      const relevance = LEX_WEIGHT * lexNorm + SEM_WEIGHT * sem;
      if (relevance >= MIN_RELEVANCE) hits.push({ doc: d, relevance });
    }
    hits.sort((a, b) => b.relevance - a.relevance);
    return hits.slice(0, limit);
  }

  async related(slug: string, limit = 3): Promise<SearchHit[]> {
    await this.ensureReady();
    const ref = this.docs.find((d) => d.type === 'post' && d.slug === slug)
      ?? this.docs.find((d) => d.slug === slug);
    if (!ref) return [];
    const hits: SearchHit[] = [];
    for (const d of this.docs) {
      if (d.id === ref.id || d.type === 'repo') continue;
      const sem = Math.max(0, cosine(ref.vector, d.vector));
      const overlap = tagOverlap(ref.tags, d.tags);
      const relevance = 0.7 * sem + 0.3 * overlap;
      if (relevance > 0.15) hits.push({ doc: d, relevance });
    }
    hits.sort((a, b) => b.relevance - a.relevance);
    return hits.slice(0, limit);
  }

  async siteSummary(): Promise<string> {
    await this.ensureReady();
    const posts = this.docs.filter((d) => d.type === 'post');
    const pages = this.docs.filter((d) => d.type === 'page');
    const repos = this.docs.filter((d) => d.type === 'repo');

    const topics = [...this.tags]
      .filter((t) => t.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
      .map((t) => `- ${t.name} (${t.count})${t.description ? ` — ${truncate(t.description, 90)}` : ''}`);

    const recent = [...posts]
      .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))
      .slice(0, 5)
      .map((p) => `- ${p.title} (${(p.published_at ?? '').slice(0, 10)}) — /${p.slug}/`);

    const pageList = pages.slice(0, 20).map((p) => `- ${p.title} — /${p.slug}/`);

    const header = this.site.description ? `${this.site.name} — ${this.site.description}` : this.site.name;
    const repoStat = repos.length ? `, ${repos.length} companion repos` : '';

    const lines = [
      header,
      '',
      `Stats: ${posts.length} articles, ${pages.length} pages, ${this.tags.length} tags${repoStat}.`,
      '',
      'Main topics:', ...topics,
      '',
      'Recent articles:', ...recent,
      '',
      'Pages:', ...pageList,
    ];
    if (this.site.url) lines.push('', `Site URL: ${this.site.url}`);
    return lines.join('\n');
  }

  stats(): { docs: number; builtAt: number; fresh: boolean } {
    return { docs: this.docs.length, builtAt: this.builtAt, fresh: this.fresh() };
  }
}
