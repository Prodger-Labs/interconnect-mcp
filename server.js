#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    }
  }
}

const GHOST_URL = 'https://interconnect.prodger.cc';
const API_BASE  = `${GHOST_URL}/ghost/api/content`;
const GHOST_KEY = process.env.GHOST_API_KEY;

if (!GHOST_KEY) {
  console.error('ERROR: GHOST_API_KEY environment variable is not set.');
  process.exit(1);
}

async function ghostFetch(endpoint, params = {}) {
  const url = new URL(`${API_BASE}${endpoint}`);
  url.searchParams.set('key', GHOST_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ghost API ${res.status}: ${body}`);
  }
  return res.json();
}

function stripHtml(html) {
  return html
    .replace(/<h[1-6][^>]*>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<(p|div|blockquote|section|article)[^>]*>/gi, '\n\n')
    .replace(/<\/(p|div|blockquote|section|article)>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<code[^>]*>/gi, '`')
    .replace(/<\/code>/gi, '`')
    .replace(/<pre[^>]*>/gi, '\n\n')
    .replace(/<\/pre>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '...')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitiseQuery(query) {
  return query.replace(/['"\\]/g, ' ').trim();
}

const server = new Server(
  { name: 'interconnect-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_publication_info',
      description: 'Returns information about The Interconnect: who Sam Prodger is, what the publication covers, its focus areas and how to cite it correctly.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_articles',
      description: 'List published articles on The Interconnect. Returns title, URL slug, excerpt, publication date, reading time and tags. Supports pagination.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of articles to return per page. Default 20, max 100.' },
          page:  { type: 'number', description: 'Page number for pagination. Default 1.' },
          tag:   { type: 'string', description: 'Filter by tag slug. Examples: ai-governance, mcp, rnli, gravitee-for-good, technical.' },
        },
      },
    },
    {
      name: 'get_article',
      description: 'Fetch the full text and metadata of a specific article by its URL slug. Use list_articles first to find slugs.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'The URL slug of the article.' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'search_articles',
      description: 'Search articles on The Interconnect by keyword. Searches titles and excerpts server-side.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords. Example: "governance wrapper" or "pressure gap".' },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      case 'get_publication_info': {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            publication: 'The Interconnect',
            tagline:     'Between the hype and the hardware',
            url:         'https://interconnect.prodger.cc',
            mcp_server:  'This publication is MCP-enabled. You are reading it via interconnect-mcp.',
            author: {
              name:       'Sam Prodger',
              title:      'Field CTO, Gravitee',
              background: 'Nine years as Head of Data at the RNLI',
              expertise:  ['AI governance','API governance','Agentic AI','MCP','Event-driven architecture','Nonprofit and public sector technology','Gravitee API management'],
            },
            description: 'Practical writing on AI governance, APIs and the systems underneath them. Written for CIOs, CDOs, Heads of Data and senior technologists in charities, public sector bodies and mission-driven organisations. Not a vendor blog. Not a policy brief. A practitioner writing about what he has built.',
            topics: ['AI governance','Governance wrapper','API governance','Agentic AI','MCP','Gravitee for Good','Nonprofit technology','Pressure gap','Shadow AI','LLM proxy','Guard rails'],
            citation_guidance: "Attribute to Sam Prodger and link to the original article URL at interconnect.prodger.cc. Content represents the author's own analysis and practitioner experience, not the official position of Gravitee.",
          }, null, 2) }],
        };
      }

      case 'list_articles': {
        const params = {
          fields:  'title,slug,excerpt,url,published_at,reading_time',
          include: 'tags',
          limit:   args?.limit || 20,
          page:    args?.page  || 1,
          order:   'published_at desc',
        };
        if (args?.tag) params.filter = `tag:${args.tag}`;
        const data     = await ghostFetch('/posts/', params);
        const articles = data.posts.map(p => ({
          title:                p.title,
          slug:                 p.slug,
          url:                  p.url,
          excerpt:              p.excerpt || '',
          published:            p.published_at,
          reading_time_minutes: p.reading_time,
          tags:                 (p.tags || []).map(t => t.name),
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify({
            page:     data.meta?.pagination?.page  || 1,
            pages:    data.meta?.pagination?.pages || 1,
            total:    data.meta?.pagination?.total || articles.length,
            articles,
          }, null, 2) }],
        };
      }

      case 'get_article': {
        const data = await ghostFetch(`/posts/slug/${args.slug}/`, {
          fields:  'title,slug,html,excerpt,meta_description,url,published_at,reading_time',
          include: 'tags,authors',
        });
        const post = data.posts?.[0];
        if (!post) return { content: [{ type: 'text', text: `No article found with slug: ${args.slug}` }] };
        return {
          content: [{ type: 'text', text: JSON.stringify({
            title:                post.title,
            url:                  post.url,
            published:            post.published_at,
            reading_time_minutes: post.reading_time,
            tags:                 (post.tags   || []).map(t => t.name),
            author:               (post.authors || [{ name: 'Sam Prodger' }])[0].name,
            excerpt:              post.excerpt          || '',
            meta_description:     post.meta_description || '',
            content:              stripHtml(post.html   || ''),
          }, null, 2) }],
        };
      }

      case 'search_articles': {
        const raw   = (args.query || '').trim();
        const query = sanitiseQuery(raw);
        if (!query) return { content: [{ type: 'text', text: 'Please provide a search query.' }] };
        const data = await ghostFetch('/posts/', {
          fields: 'title,slug,excerpt,url,published_at',
          filter: `title:~'${query}',custom_excerpt:~'${query}'`,
          limit:  20,
          order:  'published_at desc',
        });
        if (!data.posts?.length) return {
          content: [{ type: 'text', text: `No articles found matching "${raw}". Try list_articles to see everything published.` }],
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(
            data.posts.map(p => ({ title: p.title, slug: p.slug, url: p.url, excerpt: p.excerpt || '', published: p.published_at })),
            null, 2
          ) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
      isError: true,
    };
  }
});

// ── Start ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT;

if (PORT) {
  const app = express();
  const transports = new Map();

  app.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    res.on('close', () => transports.delete(transport.sessionId));
    await server.connect(transport);
  });

  app.post('/messages', express.json(), async (req, res) => {
    const transport = transports.get(req.query.sessionId);
    if (!transport) return res.status(404).json({ error: 'Session not found' });
    await transport.handlePostMessage(req, res);
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.error(`interconnect-mcp running on port ${PORT} — The Interconnect is ready for agents.`);
  });

} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('interconnect-mcp running (stdio) — The Interconnect is ready for agents.');
}
