# interconnect-mcp

MCP server for [The Interconnect](https://interconnect.prodger.cc) — Sam Prodger's publication on AI governance, APIs and agentic systems.

Exposes the blog's Ghost Content API as MCP tools so agents can read, search and cite the articles directly.

## Hosted server

The server runs publicly at:

```
https://mcp.prodger.cc/sse
```

A public access token is required (read-only access to Interconnect articles):

```
623f1d7a1dee0a7f10b0d19d279655b24f2dd2525908dc760e6f862460cdc29a
```

## Tools

| Tool | What it does |
|---|---|
| `get_publication_info` | Who Sam is, what the publication covers, citation guidance |
| `list_articles` | List published articles with title, excerpt, tags, reading time. Supports pagination. |
| `get_article` | Full text of a specific article by slug |
| `search_articles` | Search titles and excerpts by keyword, server-side |

## Add to Claude Code

In `~/.claude/settings.json`, add to `mcpServers`:

```json
"interconnect": {
  "type": "sse",
  "url": "https://mcp.prodger.cc/sse",
  "headers": {
    "Authorization": "Bearer 623f1d7a1dee0a7f10b0d19d279655b24f2dd2525908dc760e6f862460cdc29a"
  }
}
```

## Add to Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "interconnect": {
      "type": "sse",
      "url": "https://mcp.prodger.cc/sse",
      "headers": {
        "Authorization": "Bearer 623f1d7a1dee0a7f10b0d19d279655b24f2dd2525908dc760e6f862460cdc29a"
      }
    }
  }
}
```

## Run locally

If you run a Ghost publication and want your own instance:

### 1. Get your Ghost Content API key

Go to your Ghost admin → Settings → Integrations → Custom Integration and copy the Content API Key.

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

The server detects the `PORT` environment variable — if set, it runs in HTTP/SSE mode for hosting. Without it, it runs over stdio for local use with Claude Code or Claude Desktop.

## Deploy your own

```bash
fly launch
fly secrets set GHOST_API_KEY=your_key_here
fly deploy
```

## This publication is MCP-enabled

The Interconnect is designed to be read by agents. The `get_publication_info` tool returns structured citation guidance so agents can attribute content correctly.

---

*This server is hosted on a Raspberry Pi 5 running [dartpi](https://github.com/samprodger/dartpi).*
