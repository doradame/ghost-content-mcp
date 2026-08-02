# ghost-content-mcp

A **read-only [MCP](https://modelcontextprotocol.io) server that turns any [Ghost](https://ghost.org) site into a semantic content-discovery source for AI assistants.**

Point it at a Ghost site (URL + Content API key) and it exposes tools an LLM can call to
**search, summarize, and read** that site's posts, pages, and tags — ranked by a hybrid of
lexical (BM25) and **local semantic embeddings**. It's designed to power visitor-facing
chatbots and RAG, not to manage the blog.

> **How this differs from other Ghost MCP servers.** Most existing ones wrap the **Admin API**
> for content *management* (create/edit/delete posts, members, newsletters) — tools for the
> site owner. This one is the opposite: **public, read-only, retrieval-focused**. Its job is to
> answer "what does this site say about X?" well.

## Features

- 🔎 **Hybrid search** — Okapi BM25 (lexical) + `all-MiniLM-L6-v2` embeddings (semantic), so
  natural-language questions match even without shared keywords. Runs **fully locally** (model
  bundled in the image, no external inference calls).
- 🧭 **9 tools** — `search_all`, `search_posts`, `get_related_posts`, `get_site_summary`,
  `get_post`, `get_page`, `list_posts`, `list_pages`, `list_tags`.
- ⚙️ **Zero-config identity** — auto-detects the site's name/description/URL from Ghost's own
  `/settings` endpoint (override with env vars if you want).
- 🔄 **Self-updating** — in-memory index with a ~10-min TTL refresh; new content appears
  automatically. Optional internal `POST /refresh` for webhook-driven instant updates.
- 🐙 **Optional GitHub companions** — if a post links a repo you own, its README can be indexed
  and surfaced next to the article (off by default).
- 🙈 **`#noindex`** — tag any post/page `#noindex` to keep it out of discovery search (still
  fetchable by direct slug).

## Quick start

```bash
cp .env.example .env      # set GHOST_URL + GHOST_CONTENT_API_KEY
npm install
npm run build
npm start
```

Or with Docker:

```bash
docker build -t ghost-content-mcp .
docker run -p 3000:3000 --env-file .env ghost-content-mcp
```

The MCP endpoint is `POST /mcp` (Streamable HTTP, stateless JSON). `GET /health` reports index
status.

### Getting a Ghost Content API key

Ghost Admin → **Settings → Integrations → Add custom integration** → copy the **Content API
key**. (Content keys are read-only and safe to use for a public endpoint.)

## Connecting a client

Any MCP client that speaks Streamable HTTP. Example (Claude Desktop-style config):

```json
{
  "mcpServers": {
    "ghost-content": { "url": "https://your-host/mcp" }
  }
}
```

## Configuration

| Env var | Required | Default | Notes |
|---|---|---|---|
| `GHOST_URL` | ✅ | `http://localhost:2368` | Your Ghost site URL |
| `GHOST_CONTENT_API_KEY` | ✅ | — | Content API key (read-only) |
| `PORT` | | `3000` | HTTP port |
| `SITE_NAME` / `SITE_URL` / `SITE_DESCRIPTION` | | from Ghost `/settings` | Identity overrides |
| `GITHUB_COMPANION_OWNERS` | | — (off) | Comma-separated owner allowlist to enable repo companions |
| `GITHUB_TOKEN` | | — | Raises GitHub API rate limits |
| `INDEX_TTL_MS` | | `600000` | Auto-refresh interval |
| `REFRESH_TOKEN` | | — | If set, `POST /refresh` requires header `x-refresh-token` |
| `EMBEDDINGS_MODEL` | | `Xenova/all-MiniLM-L6-v2` | Sentence-embedding model |
| `EMBEDDINGS_BATCH_SIZE` | | `8` | Lower = lower peak RAM during index build |

## Tools

| Tool | Purpose |
|---|---|
| **`search_all`** | Search posts + pages (+ repos) by keyword/question, ranked by relevance. Start here. |
| `search_posts` | Same ranking, posts only. |
| `get_related_posts` | "More like this" for a given post slug. |
| `get_site_summary` | One-call overview: what the site is, topics, counts, recent posts, pages. |
| `get_post` / `get_page` | Full content as Markdown by slug. |
| `list_posts` / `list_pages` | Paginated listings (filter by tag/date, sort). |
| `list_tags` | All public tags with post counts. |

**Relevance** is `0.5·BM25 + 0.5·cosine(embeddings)`, range 0–1. As a rule of thumb: ≥0.5 is a
strong match, 0.3–0.5 weak, <0.3 noise.

## How updates work

The index rebuilds automatically every ~10 minutes (TTL); publishing in Ghost is enough. For
instant updates, wire a Ghost "post published/updated" webhook to the internal `POST /refresh`
(optionally guarded by `REFRESH_TOKEN`).

## Notes

- Requires **glibc** (Node `node:22-slim`, not Alpine) — onnxruntime-node's native binding
  doesn't load on musl.
- The embedding model (~90 MB) is downloaded at image build time and bundled, so there are no
  network calls at runtime.

## License

MIT
