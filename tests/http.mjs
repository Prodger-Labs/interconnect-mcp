// Tests for the HTTP/SSE transport, which only runs when PORT is set.
//
// integration.mjs drives the stdio transport; this covers what only exists in
// HTTP mode. Chiefly the rate limiter, whose "per IP" behaviour depends on a
// setting that is easy to get wrong in a way nothing else would reveal: with
// the wrong trust proxy value the limiter still returns headers, still counts
// down, still looks healthy — and is either global or trivially evaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

async function freePort() {
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

// Boots server.js in HTTP mode and waits for /health before handing over.
async function withHttpServer(env, fn) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, GHOST_API_KEY: 'test-key', PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${stderr}`);
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) { up = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`server never came up\n${stderr}`);

  try {
    await fn({ base, stderr: () => stderr });
  } finally {
    child.kill('SIGTERM');
  }
}

const remainingFor = async (base, ip) => {
  const res = await fetch(`${base}/health`, { headers: { 'X-Forwarded-For': ip } });
  return Number(res.headers.get('ratelimit-remaining'));
};

// ── the bug this file exists for ───────────────────────────────────────────

// Without trust proxy, every request behind a reverse proxy arrives from the
// proxy's address, so distinct clients share one bucket and the documented
// per-client limit is really a global one. Before the fix these three counted
// down 99, 98, 97.
test('with TRUST_PROXY set, distinct clients get distinct rate limit buckets', async () => {
  await withHttpServer({ TRUST_PROXY: '1' }, async ({ base }) => {
    const a = await remainingFor(base, '1.1.1.1');
    const b = await remainingFor(base, '2.2.2.2');
    const c = await remainingFor(base, '3.3.3.3');
    assert.equal(a, b, `1.1.1.1 and 2.2.2.2 shared a bucket (${a} then ${b})`);
    assert.equal(b, c, `2.2.2.2 and 3.3.3.3 shared a bucket (${b} then ${c})`);
  });
});

test('with TRUST_PROXY set, one client still consumes its own budget', async () => {
  await withHttpServer({ TRUST_PROXY: '1' }, async ({ base }) => {
    const first = await remainingFor(base, '9.9.9.9');
    const second = await remainingFor(base, '9.9.9.9');
    assert.equal(second, first - 1, 'repeat requests from one client must count down');
  });
});

// The unsafe fix is trust proxy: true, which makes Express believe any
// client-supplied X-Forwarded-For. Capping at the real hop count is what
// stops a caller minting a fresh identity per request.
test('TRUST_PROXY is a hop count, not a boolean, and is bounded', async () => {
  await withHttpServer({ TRUST_PROXY: '999' }, async ({ base, stderr }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.match(stderr(), /trust proxy = 10\b/, 'hop count should clamp to the documented maximum');
  });
});

test('an unset TRUST_PROXY says so, rather than failing silently', async () => {
  await withHttpServer({}, async ({ base, stderr }) => {
    await fetch(`${base}/health`);
    assert.match(stderr(), /TRUST_PROXY unset/);
    assert.match(stderr(), /the limit is global/);
  });
});

test('a non-numeric TRUST_PROXY falls back to not trusting anything', async () => {
  await withHttpServer({ TRUST_PROXY: 'yes-please' }, async ({ base, stderr }) => {
    await fetch(`${base}/health`);
    assert.match(stderr(), /TRUST_PROXY unset/, 'unparseable values must not be read as trust');
  });
});

// ── the endpoints themselves ───────────────────────────────────────────────

test('/health answers without authentication', async () => {
  await withHttpServer({}, async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('rate limit headers are the standard ones, not the legacy X- forms', async () => {
  await withHttpServer({}, async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.ok(res.headers.get('ratelimit-limit'), 'RateLimit-Limit missing');
    assert.equal(res.headers.get('x-ratelimit-limit'), null, 'legacy headers should be off');
  });
});

test('the documented limit of 100 is what the server actually advertises', async () => {
  await withHttpServer({}, async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(Number(res.headers.get('ratelimit-limit')), 100);
  });
});

test('posting to /messages with an unknown session is refused, not crashed', async () => {
  await withHttpServer({}, async ({ base }) => {
    const res = await fetch(`${base}/messages?sessionId=does-not-exist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'Session not found');
  });
});

test('an unknown path 404s rather than leaking a stack trace', async () => {
  await withHttpServer({}, async ({ base }) => {
    const res = await fetch(`${base}/../../etc/passwd`);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(!/at \w+ \(/.test(body), `stack trace in 404 body: ${body.slice(0, 200)}`);
    assert.ok(!body.includes('test-key'), 'API key leaked in 404 body');
  });
});
