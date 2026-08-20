// Smoke test. Boots the real server in HTTP mode and asks it for /health.
//
// There is no unit-testable logic worth pinning here: every tool is a thin
// wrapper over the Ghost content API. What this catches is the server failing
// to boot at all, which is what a dependency bump would cause. express is the
// live example: it was never declared in package.json and resolved only as a
// transitive of @modelcontextprotocol/sdk, and that SDK now ships hono too.
//
// No network call reaches Ghost. The key below only has to be non-empty, since
// the server exits 1 without one.
import { spawn } from 'node:child_process';

const PORT = 8000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), GHOST_API_KEY: 'dummy-for-smoke-test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

const fail = (msg) => {
  child.kill('SIGKILL');
  console.error(`FAIL: ${msg}`);
  if (stderr.trim()) console.error(`server stderr:\n${stderr}`);
  process.exit(1);
};

const deadline = Date.now() + 20_000;
let body = null;

while (Date.now() < deadline) {
  if (child.exitCode !== null) fail(`server exited early with code ${child.exitCode}`);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (res.ok) { body = await res.json(); break; }
  } catch {
    // not listening yet
  }
  await new Promise((r) => setTimeout(r, 250));
}

if (body === null) fail('server never answered /health within 20s');
if (body.ok !== true) fail(`/health returned ${JSON.stringify(body)}, expected {"ok":true}`);

child.kill('SIGTERM');
console.log(`ok  /health answered {"ok":true} on port ${PORT}`);
