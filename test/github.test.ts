import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractRepos, fetchRepo, _clearRepoCache } from '../src/github.js';

describe('extractRepos', () => {
  it('extracts owner-allowed repos, dedupes, and strips .git', () => {
    const html = `
      <a href="https://github.com/doradame/container-sentinel">repo</a>
      <a href="https://github.com/doradame/container-sentinel/blob/main/README.md">readme</a>
      <a href="https://github.com/doradame/CryptoSync.git">crypto</a>
    `;
    expect(extractRepos(html, ['doradame'])).toEqual([
      { owner: 'doradame', name: 'container-sentinel' },
      { owner: 'doradame', name: 'CryptoSync' },
    ]);
  });

  it('filters out repos from other owners', () => {
    const html = 'See https://github.com/BerriAI/litellm and https://github.com/doradame/lambda_ovh';
    expect(extractRepos(html, ['doradame'])).toEqual([{ owner: 'doradame', name: 'lambda_ovh' }]);
  });

  it('ignores reserved github paths (sponsors, marketplace, ...)', () => {
    const html = 'https://github.com/sponsors/doradame and https://github.com/marketplace/actions/x';
    expect(extractRepos(html, [])).toEqual([]);
  });

  it('extracts the repo even when the link points at a subpath (issues, blob)', () => {
    const html = 'https://github.com/doradame/repo/issues';
    expect(extractRepos(html, ['doradame'])).toEqual([{ owner: 'doradame', name: 'repo' }]);
  });

  it('with no owner filter, accepts any owner', () => {
    const html = 'https://github.com/foo/bar';
    expect(extractRepos(html, [])).toEqual([{ owner: 'foo', name: 'bar' }]);
  });
});

describe('fetchRepo', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { _clearRepoCache(); fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads README from the main branch and enriches with metadata', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/main/README.md')) return Promise.resolve(new Response('# Hello repo'));
      if (url.includes('api.github.com/repos/')) {
        return Promise.resolve(new Response(JSON.stringify({
          description: 'a demo', topics: ['docker'], stargazers_count: 5,
        })));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });
    const doc = await fetchRepo('doradame', 'thing');
    expect(doc).toMatchObject({
      owner: 'doradame', name: 'thing', readme: '# Hello repo',
      description: 'a demo', topics: ['docker'], stars: 5,
      url: 'https://github.com/doradame/thing',
    });
  });

  it('falls back to master, then returns null when no README exists', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    expect(await fetchRepo('doradame', 'empty')).toBeNull();
  });
});
