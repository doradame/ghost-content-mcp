import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { GhostConfig } from './ghost.js';
import { buildServer, ServerOpts } from './server.js';
import { IndexStore } from './store.js';

export function createApp(cfg: GhostConfig, store: IndexStore, opts: ServerOpts): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', index: store.stats() });
  });

  app.post('/mcp', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const server = buildServer(cfg, store, opts);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0', id: null,
          error: { code: -32603, message: 'Internal server error' },
        });
      }
    }
  });

  // Internal only: nginx does not proxy /refresh, so this is reachable only from the
  // docker network. Optionally gated by REFRESH_TOKEN. Forces an index rebuild so newly
  // published content shows up immediately (otherwise it appears within the TTL).
  app.post('/refresh', (req, res) => {
    const required = process.env.REFRESH_TOKEN;
    if (required && req.get('x-refresh-token') !== required) {
      return res.status(401).json({ status: 'unauthorized' });
    }
    // Fire-and-forget: schedule a guarded rebuild and return immediately so the request
    // never holds the connection open or does heavy work synchronously.
    store.refresh().catch((err) => console.error('index refresh failed:', (err as Error).message));
    res.json({ status: 'scheduled', index: store.stats() });
  });

  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: '2.0', id: null,
      error: { code: -32000, message: 'Method not allowed. Use POST (stateless server).' },
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}
