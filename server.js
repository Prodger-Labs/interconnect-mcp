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
import rateLimit from 'express-rate-limit';
import { stripHtml, sanitiseQuery, isValidSlug, sanitiseContent, sanitiseLogValue } from './lib/text.js';

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

// Overridable so the tool handlers can be exercised against a stub Ghost.
// Without this the four tools are untestable — which is why, until now, none
// of them had a test. Defaults to the real publication, so nothing changes
// unless GHOST_URL is deliberately set.
const GHOST_URL = process.env.GHOST_URL || 'https://interconnect.prodger.cc';
const API_BASE  = `${GHOST_URL}/ghost/api/content`;
const GHOST_KEY = process.env.GHOST_API_KEY;

if (!GHOST_KEY) {
  console.error('ERROR: GHOST_API_KEY environment variable is not set.');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────

// A tool call waits on this, and an agent waits on the tool call. Without a
// deadline a Ghost that accepts the connection and then never answers hangs
// the caller indefinitely, with nothing to distinguish it from slow work.
const GHOST_TIMEOUT_MS = clampInt(process.env.GHOST_TIMEOUT_MS, {
  min: 1000, max: 120_000, fallback: 10_000,
});

async function ghostFetch(endpoint, params = {}) {
  const url = new URL(`${API_BASE}${endpoint}`);
  url.searchParams.set('key', GHOST_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(GHOST_TIMEOUT_MS) });
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError. Say so plainly rather
    // than surfacing a bare "fetch failed", which reads like a bug in us.
    if (err?.name === 'TimeoutError') {
      throw new Error(`Ghost API did not respond within ${GHOST_TIMEOUT_MS}ms`);
    }
    throw new Error(`Ghost API unreachable: ${err?.name ?? 'Error'}`);
  }

  if (!res.ok) {
    // The body is attacker-influenceable in a way article HTML is not assumed
    // to be, and it lands in the agent's context via err.message without ever
    // passing stripHtml. Run it through the same defence and cap it, so an
    // error cannot become an injection channel or flood the context window.
    // The body does not reach the agent. It is attacker-influenceable, and it
    // was an injection channel that sanitiseContent could not close: that
    // function anchors its rules to start-of-string and newline because it
    // guards article prose, and a JSON error body has no line structure for
    // those anchors to bind to — "Human:" sits behind a quote, so the rule
    // correctly declines to match and the text passed through intact.
    //
    // Filtering was the wrong instrument. An agent needs to know the call
    // failed and what the status was; Ghost's internal error prose is for
    // whoever operates this. So it goes to the log, where it is flattened and
    // capped, and the agent gets the status alone.
    logRequest('ghost_error', `status=${res.status} body=${(await res.text()).slice(0, 500)}`);
    throw new Error(`Ghost API ${res.status}`);
  }
  return res.json();
}

// stripHtml, sanitiseQuery, isValidSlug and sanitiseContent live in lib/text.js
// so they can be unit tested without booting a server.

// Coerce an agent-supplied number into the documented range. The inputSchema
// advertises "max 100", and nothing was holding us to it: limit=10000 went
// straight to Ghost and returned the whole corpus into the caller's context,
// while limit=-5 was passed through as-is. A schema the server does not
// enforce is a promise to the agent that it does not keep.
function clampInt(value, { min, max, fallback }) {
  // Anything that is not a number or a numeric string is "not supplied", not
  // zero. Number(null), Number('') and Number([]) are all 0, which is finite,
  // so they used to clamp to min — an agent sending {"limit": null} got one
  // article back instead of the default twenty. Only genuine numbers and
  // numeric strings get as far as the clamp.
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// Simple request logger — writes to stderr, captured by Fly.io logs.
// One line per tool call, to stderr. These lines are the audit trail, so the
// flattening matters as much as the content: a newline reaching here let a
// caller close the record and write a convincing forged one after it.
// Callers should still pass values they have already validated where they
// can — this is the backstop, not the only guard.
function logRequest(tool, detail = '') {
  const ts = new Date().toISOString();
  const line = `[${ts}] tool=${sanitiseLogValue(tool, 40)}`
    + (detail ? ` ${sanitiseLogValue(detail, 300)}` : '');
  console.error(line);
}

// ── MCP Server ─────────────────────────────────────────────────────────────

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
        logRequest('get_publication_info');
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
          limit:   clampInt(args?.limit, { min: 1, max: 100, fallback: 20 }),
          page:    clampInt(args?.page,  { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 1 }),
          order:   'published_at desc',
        };
        if (args?.tag) params.filter = `tag:${sanitiseQuery(args.tag)}`;
        // Logged after the params are built, and from the params themselves.
        // Logging the raw arguments made the record disagree with the request
        // the moment clamping was added — limit=10000 was logged while Ghost
        // received 100. An audit line describing a request that was never
        // made is worse than no line.
        logRequest('list_articles', `page=${params.page} limit=${params.limit}`
          + (params.filter ? ` filter=${params.filter}` : ''));
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
        if (!isValidSlug(args.slug)) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid slug format.' }) }] };
        }
        logRequest('get_article', `slug=${args.slug}`);
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
            content:              sanitiseContent(stripHtml(post.html || '')),
          }, null, 2) }],
        };
      }

      case 'search_articles': {
        const raw   = (args.query || '').trim();
        const query = sanitiseQuery(raw);
        if (!query) return { content: [{ type: 'text', text: 'Please provide a search query.' }] };
        logRequest('search_articles', `query="${query}"`);
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

  // Behind a reverse proxy every request arrives from the proxy's address, so
  // with Express's default trust proxy of false the limiter sees one client
  // and the "per IP" limit silently becomes global: 100 requests per 15
  // minutes shared across everybody, where one busy agent locks out the rest.
  // express-rate-limit emits ERR_ERL_UNEXPECTED_X_FORWARDED_FOR about exactly
  // this. Verified before the fix: three requests carrying different
  // X-Forwarded-For values counted down 99, 98, 97 off a single bucket.
  //
  // TRUST_PROXY is the number of proxy hops in front of this server — 1 for
  // Fly.io and most PaaS. It defaults to 0 because trusting a hop that is not
  // there is the worse failure: Express would then believe a client-supplied
  // X-Forwarded-For, and anyone could evade the limiter outright by varying
  // it. A global limit throttles honest traffic; a spoofable one stops
  // nothing at all.
  const TRUST_PROXY = clampInt(process.env.TRUST_PROXY, { min: 0, max: 10, fallback: 0 });
  if (TRUST_PROXY > 0) {
    app.set('trust proxy', TRUST_PROXY);
    console.error(`trust proxy = ${TRUST_PROXY}; rate limiting keys on the client address.`);
  } else {
    console.error('TRUST_PROXY unset; rate limiting keys on the socket address. '
      + 'If this is deployed behind a proxy, set TRUST_PROXY to the hop count or the limit is global.');
  }

  // Rate limiting — 100 requests per client per 15 minutes, where "client" is
  // resolved according to TRUST_PROXY above.
  app.use(rateLimit({
    windowMs:        15 * 60 * 1000,
    max:             100,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { error: 'Too many requests, please try again later.' },
  }));

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
