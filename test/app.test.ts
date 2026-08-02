import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { IndexStore } from '../src/store.js';

const cfg = { url: 'http://localhost:2368', key: 'abc123' };
const site = { name: 'TestSite', description: 'A test Ghost site', url: 'https://test.example', lang: 'en' };
const store = new IndexStore(cfg, { site, embed: async () => [], embedOne: async () => new Float32Array(1) });
let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp(cfg, store, { owners: [], site });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// The MCP transport uses global fetch only via the ghost client; the HTTP test
// hits the Express server over a real socket, so we must NOT stub fetch here
// except inside ghost-bound calls. initialize/tools-list don't touch Ghost.

describe('HTTP endpoint', () => {
  it('GET /health returns ok', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });

  it('POST /mcp handles initialize statelessly with no-store header', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe('ghost-content');
  });

  it('GET /mcp returns 405', async () => {
    const res = await fetch(`${base}/mcp`);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.message).toMatch(/method not allowed/i);
  });

  it('DELETE /mcp returns 405', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'DELETE' });
    expect(res.status).toBe(405);
  });
});
