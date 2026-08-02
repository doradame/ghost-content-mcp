import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listPosts, getPost, searchPosts, listTags, GhostError } from '../src/ghost.js';

const cfg = { url: 'http://ghost:2368', key: 'abc123' };

function ghostPost(over: Record<string, unknown> = {}) {
  return {
    title: 'Hello', slug: 'hello', excerpt: 'An excerpt',
    html: '<p>Hi</p>', published_at: '2026-01-02T03:04:05.000Z',
    url: 'https://mojalab.com/hello/',
    tags: [{ name: 'Linux', slug: 'linux' }],
    ...over,
  };
}

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('listPosts', () => {
  it('calls the content API with key, include and pagination, and maps the result', async () => {
    fetchMock.mockResolvedValue(okJson({
      posts: [ghostPost()],
      meta: { pagination: { page: 1, pages: 3, total: 25 } },
    }));
    const { posts, pagination } = await listPosts(cfg, { page: 1, limit: 10 });
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/ghost/api/content/posts/');
    expect(calledUrl.searchParams.get('key')).toBe('abc123');
    expect(calledUrl.searchParams.get('include')).toBe('tags');
    expect(calledUrl.searchParams.get('limit')).toBe('10');
    expect(calledUrl.searchParams.get('fields')).toBe('title,slug,custom_excerpt,excerpt,published_at,url');
    expect(posts[0]).toMatchObject({ title: 'Hello', slug: 'hello', tags: ['Linux'] });
    expect(pagination).toEqual({ page: 1, pages: 3, total: 25 });
  });

  it('adds a tag filter when requested', async () => {
    fetchMock.mockResolvedValue(okJson({ posts: [], meta: { pagination: { page: 1, pages: 1, total: 0 } } }));
    await listPosts(cfg, { tag: 'linux' });
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('filter')).toBe('tag:linux');
  });
});

describe('getPost', () => {
  it('fetches a post by slug with html', async () => {
    fetchMock.mockResolvedValue(okJson({ posts: [ghostPost()] }));
    const post = await getPost(cfg, 'hello');
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/ghost/api/content/posts/slug/hello/');
    expect(post.html).toBe('<p>Hi</p>');
  });

  it('throws GhostError with a clear message on 404', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ errors: [{ message: 'Post not found.' }] }), { status: 404 }));
    await expect(getPost(cfg, 'nope')).rejects.toThrow(GhostError);
    await expect(getPost(cfg, 'nope')).rejects.toThrow(/not found/i);
  });
});

describe('searchPosts', () => {
  it('builds an NQL contains-filter on title and plaintext, stripping quotes', async () => {
    fetchMock.mockResolvedValue(okJson({ posts: [], meta: { pagination: { page: 1, pages: 1, total: 0 } } }));
    await searchPosts(cfg, "wire'guard");
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('filter')).toBe("title:~'wireguard',plaintext:~'wireguard'");
    expect(calledUrl.searchParams.get('fields')).toBe('title,slug,custom_excerpt,excerpt,published_at,url');
  });

  it('returns an empty array without calling fetch when the query is empty or whitespace', async () => {
    await expect(searchPosts(cfg, '   ')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty array without calling fetch when the query is only strippable characters', async () => {
    await expect(searchPosts(cfg, "''\\\\")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listTags', () => {
  it('fetches all public tags with post counts', async () => {
    fetchMock.mockResolvedValue(okJson({
      tags: [{ name: 'Linux', slug: 'linux', description: null, count: { posts: 7 } }],
    }));
    const tags = await listTags(cfg);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/ghost/api/content/tags/');
    expect(calledUrl.searchParams.get('include')).toBe('count.posts');
    expect(calledUrl.searchParams.get('limit')).toBe('all');
    expect(tags[0]).toEqual({ name: 'Linux', slug: 'linux', description: '', count: 7 });
  });
});
