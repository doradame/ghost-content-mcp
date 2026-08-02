import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveSiteInfo } from '../src/config.js';

const cfg = { url: 'http://localhost:2368', key: 'k' };

function settingsRes(settings: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ settings }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}

afterEach(() => { vi.unstubAllGlobals(); delete process.env.SITE_NAME; delete process.env.SITE_URL; delete process.env.SITE_DESCRIPTION; });

describe('resolveSiteInfo', () => {
  it('auto-derives identity from Ghost /settings', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      settingsRes({ title: 'My Blog', description: 'thoughts', url: 'https://blog.example/', lang: 'it' })));
    const s = await resolveSiteInfo(cfg);
    expect(s).toEqual({ name: 'My Blog', description: 'thoughts', url: 'https://blog.example', lang: 'it' });
  });

  it('lets env vars override Ghost', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      settingsRes({ title: 'My Blog', description: 'thoughts', url: 'https://blog.example/', lang: 'en' })));
    process.env.SITE_NAME = 'Override';
    process.env.SITE_URL = 'https://override.example/';
    const s = await resolveSiteInfo(cfg);
    expect(s.name).toBe('Override');
    expect(s.url).toBe('https://override.example');
    expect(s.description).toBe('thoughts'); // not overridden → from Ghost
  });

  it('falls back safely when Ghost is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('down'))));
    const s = await resolveSiteInfo(cfg);
    expect(s.name).toBe('this Ghost site');
    expect(s.url).toBe('http://localhost:2368');
  });
});
