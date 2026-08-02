import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IndexStore } from '../src/store.js';
import { _clearRepoCache } from '../src/github.js';

const cfg = { url: 'http://ghost:2368', key: 'abc123' };

const posts = [
  {
    title: 'Docker Security', slug: 'docker-security',
    excerpt: 'Hardening containers', custom_excerpt: 'Hardening containers',
    plaintext: 'docker security hardening containers guide best practices',
    html: 'Repo: <a href="https://github.com/doradame/thing">code</a>',
    published_at: '2026-06-15T00:00:00.000Z', url: 'https://mojalab.com/docker-security/',
    tags: [{ name: 'Linux', slug: 'linux' }],
  },
  {
    title: 'Python Pandas', slug: 'python-pandas',
    excerpt: 'Data science', custom_excerpt: 'Data science',
    plaintext: 'python pandas dataframe data science analysis',
    html: '<p>no repo here</p>',
    published_at: '2026-03-01T00:00:00.000Z', url: 'https://mojalab.com/python-pandas/',
    tags: [{ name: 'Linux', slug: 'linux' }],
  },
];
const pages = [
  {
    title: 'DNS Tools', slug: 'dns-tools',
    excerpt: 'Lookup DNS', custom_excerpt: 'Lookup DNS',
    plaintext: 'dns lookup propagation tool records domain',
    html: '<p>tool</p>', published_at: '2026-05-01T00:00:00.000Z',
    url: 'https://mojalab.com/dns-tools/', tags: [{ name: 'DNS', slug: 'dns' }],
  },
];
const tags = [
  { name: 'Linux', slug: 'linux', description: 'Linux stuff', count: { posts: 2 } },
  { name: 'DNS', slug: 'dns', description: '', count: { posts: 0 } },
];

function jsonRes(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function mockFetch(url: string) {
  if (url.includes('/ghost/api/content/posts/')) return Promise.resolve(jsonRes({ posts, meta: {} }));
  if (url.includes('/ghost/api/content/pages/')) return Promise.resolve(jsonRes({ pages, meta: {} }));
  if (url.includes('/ghost/api/content/tags/')) return Promise.resolve(jsonRes({ tags }));
  if (url.includes('/doradame/thing/main/README.md')) {
    return Promise.resolve(new Response('container sentinel forensics docker log analysis'));
  }
  if (url.includes('api.github.com/repos/doradame/thing')) {
    return Promise.resolve(jsonRes({ description: 'sentinel', topics: ['security'], stargazers_count: 3 }));
  }
  return Promise.resolve(new Response('', { status: 404 }));
}

// zero vectors → semantic score is 0, so ranking is purely lexical/tag-based and deterministic
const zeros = () => new Float32Array(8);
function makeStore() {
  return new IndexStore(cfg, {
    owners: ['doradame'],
    site: { name: 'TestSite', description: 'A test site', url: 'https://test.example', lang: 'en' },
    embed: async (texts) => texts.map(zeros),
    embedOne: async () => zeros(),
  });
}

beforeEach(() => { _clearRepoCache(); vi.stubGlobal('fetch', vi.fn(mockFetch)); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('IndexStore', () => {
  it('search_posts ranks the matching post and excludes non-matches', async () => {
    const store = makeStore();
    const hits = await store.search('docker security', { type: 'posts' });
    expect(hits[0].doc.slug).toBe('docker-security');
    expect(hits.map((h) => h.doc.slug)).not.toContain('python-pandas');
    expect(hits[0].relevance).toBeGreaterThan(0);
  });

  it('search_all finds pages and companion repos', async () => {
    const store = makeStore();
    const dns = await store.search('dns lookup', { type: 'all' });
    expect(dns.some((h) => h.doc.type === 'page' && h.doc.slug === 'dns-tools')).toBe(true);

    const repo = await store.search('forensics', { type: 'repos' });
    expect(repo.some((h) => h.doc.type === 'repo' && h.doc.slug === 'doradame/thing')).toBe(true);
    expect(repo[0].doc.articles?.[0].slug).toBe('docker-security');
  });

  it('applies the since filter', async () => {
    const store = makeStore();
    const recent = await store.search('docker', { type: 'posts', since: '2026-07-01' });
    expect(recent).toEqual([]); // docker post is from 2026-06-15
  });

  it('records companion repo links per article', async () => {
    const store = makeStore();
    await store.search('docker', { type: 'posts' }); // triggers build
    expect(store.companionsFor('docker-security')).toEqual(['https://github.com/doradame/thing']);
    expect(store.companionsFor('python-pandas')).toEqual([]);
  });

  it('related() surfaces posts sharing tags', async () => {
    const store = makeStore();
    const rel = await store.related('docker-security', 3);
    expect(rel.map((h) => h.doc.slug)).toContain('python-pandas');
  });

  it('siteSummary reports counts and topics', async () => {
    const store = makeStore();
    const s = await store.siteSummary();
    expect(s).toContain('2 articles');
    expect(s).toContain('Linux');
    expect(s).toContain('TestSite');
    expect(s).toContain('https://test.example');
  });
});
