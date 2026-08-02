import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { IndexStore } from '../src/store.js';

const cfg = { url: 'http://ghost:2368', key: 'abc123' };
const store = new IndexStore(cfg, { embed: async () => [], embedOne: async () => new Float32Array(1) });

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

const samplePost = {
  title: 'Hello World', slug: 'hello-world',
  excerpt: 'Greeting post', custom_excerpt: null,
  html: '<h2>Hi</h2><p>Welcome</p>',
  published_at: '2026-01-02T03:04:05.000Z',
  url: 'https://mojalab.com/hello-world/',
  tags: [{ name: 'Linux', slug: 'linux' }],
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

async function connectedClient() {
  const server = buildServer(cfg, store, { owners: [], site: { name: 'TestSite', description: '', url: 'https://test.example', lang: 'en' } });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe('buildServer', () => {
  it('exposes the full content tool set', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'get_page', 'get_post', 'get_related_posts', 'get_site_summary',
      'list_pages', 'list_posts', 'list_tags', 'search_all', 'search_posts',
    ]);
  });

  it('list_posts returns formatted text with pagination info', async () => {
    fetchMock.mockResolvedValue(okJson({
      posts: [samplePost],
      meta: { pagination: { page: 1, pages: 2, total: 12 } },
    }));
    const client = await connectedClient();
    const res: any = await client.callTool({ name: 'list_posts', arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text as string;
    expect(text).toContain('Hello World');
    expect(text).toContain('hello-world');
    expect(text).toContain('page 1/2');
  });

  it('get_post returns the post as markdown with metadata', async () => {
    fetchMock.mockResolvedValue(okJson({ posts: [samplePost] }));
    const client = await connectedClient();
    const res: any = await client.callTool({
      name: 'get_post', arguments: { slug: 'hello-world' },
    });
    const text = res.content[0].text as string;
    expect(text).toContain('# Hello World');
    expect(text).toContain('## Hi');
    expect(text).toContain('https://mojalab.com/hello-world/');
  });

  it('get_post returns isError (not a crash) for unknown slug', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ errors: [{ message: 'Post not found.' }] }), { status: 404 }));
    const client = await connectedClient();
    const res: any = await client.callTool({ name: 'get_post', arguments: { slug: 'nope' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
  });

  it('lists posts as ghost:// resources and reads one back as markdown', async () => {
    // listResources() aggregates every registered resource template (ghost-post
    // AND ghost-page), so it issues two fetch() calls here. mockResolvedValue
    // would hand back the same Response instance for both, and a Response body
    // can only be read once — use mockImplementation so each call gets a fresh one.
    fetchMock.mockImplementation(() => Promise.resolve(okJson({
      posts: [samplePost],
      meta: { pagination: { page: 1, pages: 1, total: 1 } },
    })));
    const client = await connectedClient();
    const { resources } = await client.listResources();
    const post = resources.find((r) => r.uri === 'ghost://post/hello-world');
    expect(post?.name).toBe('Hello World');

    fetchMock.mockImplementation(() => Promise.resolve(okJson({ posts: [samplePost] })));
    const read = await client.readResource({ uri: 'ghost://post/hello-world' });
    expect(read.contents[0].mimeType).toBe('text/markdown');
    expect(read.contents[0].text).toContain('## Hi');
  });
});
