import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  GhostConfig, PostSummary, PostFull,
  listPosts, getPost, listPages, getPage, listTags,
} from './ghost.js';
import { htmlToMarkdown } from './markdown.js';
import { extractRepos } from './github.js';
import { IndexStore, Hit, SearchHit } from './store.js';
import { SiteInfo } from './config.js';

export interface ServerOpts { owners: string[]; site: SiteInfo }

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'unpublished';
}

function fmtSummary(p: PostSummary): string {
  const tags = p.tags.length ? ` — tags: ${p.tags.join(', ')}` : '';
  const excerpt = p.excerpt ? `\n  ${p.excerpt}` : '';
  return `- **${p.title}** (slug: ${p.slug}) — ${fmtDate(p.published_at)}${tags}${excerpt}`;
}

function truncate(s: string, len: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= len) return clean;
  const cut = clean.slice(0, len);
  const sp = cut.lastIndexOf(' ');
  return (sp > len * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

function excerptOf(d: Hit, len: number): string {
  // For a chunk hit, show the matching section's text; for a whole-doc hit, prefer the excerpt.
  const src = d.heading ? d.text : (len > d.excerpt.length && d.text ? d.text : d.excerpt || d.text);
  return truncate(src, len);
}

function fmtHit(h: SearchHit, len: number, withType: boolean): string {
  const d = h.doc;
  const prefix = withType ? `[${d.type}] ` : '';
  const section = d.heading ? ` › ${d.heading}` : '';
  const link = d.anchor ? `${d.url}#${d.anchor}` : d.url; // deep-link to the matching section
  const meta = d.type === 'repo'
    ? (d.articles?.length ? ` — companion of: ${d.articles.map((a) => a.slug).join(', ')}` : '')
    : ` — ${fmtDate(d.published_at)}${d.tags.length ? ` — tags: ${d.tags.join(', ')}` : ''}`;
  const rel = ` — relevance: ${h.relevance.toFixed(2)}`;
  const ex = excerptOf(d, len);
  return `- ${prefix}**${d.title}**${section} (slug: ${d.slug}, url: ${link})${meta}${rel}${ex ? `\n  ${ex}` : ''}`;
}

function fmtFull(p: PostFull, companions: string[]): string {
  const tags = p.tags.length ? p.tags.join(', ') : 'none';
  const parts = [
    `# ${p.title}`,
    '',
    `*Published: ${fmtDate(p.published_at)} | Tags: ${tags} | URL: ${p.url}*`,
    '',
    htmlToMarkdown(p.html),
  ];
  if (companions.length) {
    parts.push('', `**Companion repository:** ${companions.join(', ')}`);
  }
  return parts.join('\n');
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function fail(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
    isError: true,
  };
}

export function buildServer(cfg: GhostConfig, store: IndexStore, opts: ServerOpts): McpServer {
  const server = new McpServer({ name: 'ghost-content', version: '1.0.0' });
  const site = opts.site.name; // e.g. "MojaLab" or "this Ghost site"

  server.registerTool('list_posts', {
    title: 'List blog posts',
    description:
      `List published blog posts from ${site} (title, slug, excerpt, tags, date). Paginated; ` +
      'optionally filter by tag slug, filter by publish date, and sort.',
    inputSchema: {
      page: z.number().int().min(1).optional().describe('Page number (default 1)'),
      limit: z.number().int().min(1).max(50).optional().describe('Posts per page (default 10, max 50)'),
      tag: z.string().optional().describe('Filter by tag slug (see list_tags)'),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only posts published on/after this date (YYYY-MM-DD)'),
      sort: z.enum(['date_desc', 'date_asc', 'title']).optional().describe('Sort order (default date_desc)'),
    },
  }, async ({ page, limit, tag, since, sort }) => {
    try {
      const { posts, pagination } = await listPosts(cfg, { page, limit, tag, since, sort });
      if (posts.length === 0) return ok('No posts found.');
      const header = `Posts (page ${pagination.page}/${pagination.pages}, ${pagination.total} total):`;
      return ok([header, ...posts.map(fmtSummary)].join('\n'));
    } catch (err) { return fail(err); }
  });

  server.registerTool('search_posts', {
    title: 'Search blog posts',
    description:
      `Search published posts on ${site} by keyword or natural-language query. Results are ranked ` +
      'by relevance (0–1) using hybrid lexical + semantic matching. Use excerpt_length for longer previews.',
    inputSchema: {
      query: z.string().min(1).describe('Keyword or question to search for'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
      excerpt_length: z.number().int().min(50).max(500).optional().describe('Max excerpt characters (default 150)'),
    },
  }, async ({ query, limit, excerpt_length }) => {
    try {
      const hits = await store.search(query, { limit: limit ?? 5, type: 'posts' });
      if (hits.length === 0) return ok(`No posts matching "${query}".`);
      const len = excerpt_length ?? 150;
      return ok([`Posts matching "${query}" (${hits.length}):`, ...hits.map((h) => fmtHit(h, len, false))].join('\n'));
    } catch (err) { return fail(err); }
  });

  server.registerTool('search_all', {
    title: 'Search all content',
    description:
      `Search across all published content on ${site} — blog posts, static pages, and (if configured) ` +
      'companion GitHub repositories — ranked by relevance. Each result is prefixed with [post], [page], or [repo].',
    inputSchema: {
      query: z.string().min(1).describe('Keyword or question to search for'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (default 10)'),
      content_type: z.enum(['all', 'posts', 'pages', 'repos']).optional().describe('Restrict to a content type (default all)'),
      excerpt_length: z.number().int().min(50).max(500).optional().describe('Max excerpt characters (default 150)'),
    },
  }, async ({ query, limit, content_type, excerpt_length }) => {
    try {
      const hits = await store.search(query, { limit: limit ?? 10, type: content_type ?? 'all' });
      if (hits.length === 0) return ok(`No results for "${query}".`);
      const len = excerpt_length ?? 150;
      return ok([`Results for "${query}" (${hits.length}):`, ...hits.map((h) => fmtHit(h, len, true))].join('\n'));
    } catch (err) { return fail(err); }
  });

  server.registerTool('get_site_summary', {
    title: 'Get site summary',
    description:
      `Get a concise overview of ${site} in one call: what the site is about, main topics, ` +
      `article/page counts, recent articles, and available pages. Use for broad questions like "what is ${site}?".`,
    inputSchema: {},
  }, async () => {
    try { return ok(await store.siteSummary()); }
    catch (err) { return fail(err); }
  });

  server.registerTool('get_related_posts', {
    title: 'Get related posts',
    description: 'Get posts related to a given post (by shared tags and content similarity), for recommendations.',
    inputSchema: {
      slug: z.string().describe('Slug of the reference post'),
      limit: z.number().int().min(1).max(10).optional().describe('Max related posts (default 3)'),
    },
  }, async ({ slug, limit }) => {
    try {
      const hits = await store.related(slug, limit ?? 3);
      if (hits.length === 0) return ok(`No related posts found for "${slug}".`);
      return ok([`Posts related to "${slug}":`, ...hits.map((h) => fmtHit(h, 150, false))].join('\n'));
    } catch (err) { return fail(err); }
  });

  server.registerTool('get_post', {
    title: 'Get a blog post',
    description: `Get the full content of a published ${site} blog post as Markdown, by slug. Includes any companion repository link.`,
    inputSchema: { slug: z.string().describe('Post slug, e.g. "hello-world"') },
  }, async ({ slug }) => {
    try {
      const post = await getPost(cfg, slug);
      const companions = extractRepos(post.html, opts.owners).map((r) => `https://github.com/${r.owner}/${r.name}`);
      return ok(fmtFull(post, companions));
    } catch (err) { return fail(err); }
  });

  server.registerTool('list_tags', {
    title: 'List tags',
    description: `List all public tags on ${site} with their post counts and descriptions.`,
    inputSchema: {},
  }, async () => {
    try {
      const tags = await listTags(cfg);
      if (tags.length === 0) return ok('No tags found.');
      const lines = tags.map((t) =>
        `- ${t.name} (slug: ${t.slug}, ${t.count} posts)${t.description ? ` — ${t.description}` : ''}`);
      return ok(['Tags:', ...lines].join('\n'));
    } catch (err) { return fail(err); }
  });

  server.registerTool('list_pages', {
    title: 'List static pages',
    description: `List published static pages on ${site} (about, contact, ...).`,
    inputSchema: {
      page: z.number().int().min(1).optional().describe('Page number (default 1)'),
      limit: z.number().int().min(1).max(50).optional().describe('Pages per page (default 10, max 50)'),
    },
  }, async ({ page, limit }) => {
    try {
      const { posts, pagination } = await listPages(cfg, { page, limit });
      if (posts.length === 0) return ok('No pages found.');
      const header = `Pages (page ${pagination.page}/${pagination.pages}, ${pagination.total} total):`;
      return ok([header, ...posts.map(fmtSummary)].join('\n'));
    } catch (err) { return fail(err); }
  });

  server.registerTool('get_page', {
    title: 'Get a static page',
    description: `Get the full content of a published ${site} static page as Markdown, by slug.`,
    inputSchema: { slug: z.string().describe('Page slug, e.g. "about"') },
  }, async ({ slug }) => {
    try { return ok(fmtFull(await getPage(cfg, slug), [])); }
    catch (err) { return fail(err); }
  });

  server.registerResource(
    'ghost-post',
    new ResourceTemplate('ghost://post/{slug}', {
      list: async () => {
        const { posts } = await listPosts(cfg, { page: 1, limit: 100 });
        return {
          resources: posts.map((p) => ({
            uri: `ghost://post/${p.slug}`, name: p.title,
            description: p.excerpt, mimeType: 'text/markdown',
          })),
        };
      },
    }),
    { title: `${site} blog posts`, description: 'Published blog posts as Markdown' },
    async (uri, { slug }) => {
      const post = await getPost(cfg, String(slug));
      const companions = extractRepos(post.html, opts.owners).map((r) => `https://github.com/${r.owner}/${r.name}`);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: fmtFull(post, companions) }] };
    },
  );

  server.registerResource(
    'ghost-page',
    new ResourceTemplate('ghost://page/{slug}', {
      list: async () => {
        const { posts } = await listPages(cfg, { page: 1, limit: 100 });
        return {
          resources: posts.map((p) => ({
            uri: `ghost://page/${p.slug}`, name: p.title,
            description: p.excerpt, mimeType: 'text/markdown',
          })),
        };
      },
    }),
    { title: `${site} static pages`, description: 'Published static pages as Markdown' },
    async (uri, { slug }) => {
      const page = await getPage(cfg, String(slug));
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: fmtFull(page, []) }] };
    },
  );

  return server;
}
