# interconnect-mcp

MCP server for [The Interconnect](https://interconnect.prodger.cc), Sam Prodger's publication on AI governance, APIs and agentic systems.

Exposes the blog's Ghost Content API as MCP tools so agents can read, search and cite the articles directly.

There is no public instance of this server. Run your own against any Ghost publication.

## Tools

| Tool | What it does |
|---|---|
| `get_publication_info` | Who Sam is, what the publication covers, citation guidance |
| `list_articles` | List published articles with title, excerpt, tags, reading time. Supports pagination. |
| `get_article` | Full text of a specific article by slug |
| `search_articles` | Search titles and excerpts by keyword, server-side |

## Run locally

### 1. Get your Ghost Content API key

Go to your Ghost admin, then Settings, Integrations, Custom Integration, and copy the Content API Key.

### 2. Configure

```bash
cp .env.example .env
# edit .env and paste your key
```

### 3. Install and run

```bash
npm install
npm start
```

The server detects the `PORT` environment variable. If set, it runs in HTTP/SSE mode for hosting. Without it, it runs over stdio for local use with Claude Code or Claude Desktop.

## Add to Claude Code

Point Claude Code at your local checkout. Stdio, so no token and no hosting needed:

```json
"interconnect": {
  "command": "node",
  "args": ["/absolute/path/to/interconnect-mcp/server.js"],
  "env": {
    "GHOST_API_KEY": "your_content_api_key"
  }
}
```

## Add to Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "interconnect": {
      "command": "node",
      "args": ["/absolute/path/to/interconnect-mcp/server.js"],
      "env": {
        "GHOST_API_KEY": "your_content_api_key"
      }
    }
  }
}
```

## Deploy your own

```bash
fly launch
fly secrets set GHOST_API_KEY=your_key_here
fly secrets set TRUST_PROXY=1
fly deploy
```

Set `PORT` so the server comes up in HTTP/SSE mode, and put your own auth in front of it.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `GHOST_API_KEY` | — | Required. Ghost Content API key. The server exits without it. |
| `PORT` | unset | Set for HTTP/SSE mode. Unset for stdio. |
| `TRUST_PROXY` | `0` | Number of proxy hops in front of the server. |
| `GHOST_URL` | the publication | Ghost base URL. Override to point at another site. |

`TRUST_PROXY` matters more than it looks. Behind a reverse proxy every request
arrives from the proxy's address, so at the default of `0` the rate limiter
sees a single client and its 100-per-15-minutes becomes a **global** budget
shared by everyone — one busy agent locks out the rest. Set it to the real hop
count (`1` for Fly.io and most PaaS) and the limit applies per client.

Set it to the real number, not a large one. Each hop you claim is a header the
server will believe, so over-trusting lets a caller supply their own
`X-Forwarded-For` and mint a fresh identity per request, evading the limiter
entirely. If you are not behind a proxy, leave it at `0`.

## This publication is MCP-enabled

The Interconnect is designed to be read by agents. The `get_publication_info` tool returns structured citation guidance so agents can attribute content correctly.
