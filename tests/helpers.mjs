// Shared harness for the security regression tests.
//
// The tests never touch the real repository: every case runs against a fresh
// copy of `server.mjs` / `lib` / `public` / `scripts` inside a temp dir, with
// its own content root, data dir and port. Destructive export cases therefore
// cannot harm the working tree even if the guard regresses.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A throwaway app tree laid out exactly like the repo, minus config.json and
// data/ (so the server uses its built-in defaults).
export async function makeAppCopy() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-sec-'));
  const app = path.join(base, 'app');
  await fs.mkdir(app, { recursive: true });
  for (const entry of ['server.mjs', 'lib', 'public', 'scripts']) {
    await fs.cp(path.join(repoRoot, entry), path.join(app, entry), { recursive: true });
  }

  const demo = path.join(app, 'courses', 'demo');
  await fs.mkdir(path.join(demo, 'lessons'), { recursive: true });
  await fs.writeFile(path.join(demo, 'MISSION.md'), '# Demo\n\nA test course.\n');
  await fs.writeFile(
    path.join(demo, 'lessons', '01.html'),
    '<!doctype html><title>One</title><h1>One</h1>',
  );

  const doomed = path.join(app, 'courses', 'doomed');
  await fs.mkdir(path.join(doomed, 'lessons'), { recursive: true });
  await fs.writeFile(path.join(doomed, 'MISSION.md'), '# Doomed\n');
  await fs.writeFile(path.join(doomed, 'lessons', '01.html'), '<title>Bye</title>');

  // A sibling of `courses/` — the target of the traversal attack.
  const outside = path.join(app, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP-SECRET');

  await fs.writeFile(path.join(app, 'victim.txt'), 'do-not-move');

  return {
    base,
    app,
    async cleanup() {
      await fs.rm(base, { recursive: true, force: true });
    },
  };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startServer(app, port) {
  const child = spawn(
    process.execPath,
    ['server.mjs', '--host', '127.0.0.1', '--port', String(port), '--content', './courses', '--no-password'],
    { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode})\n${output}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not start\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return {
    child,
    get output() {
      return output;
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function dechunk(text) {
  let out = '';
  let rest = text;
  for (;;) {
    const eol = rest.indexOf('\r\n');
    if (eol === -1) return out;
    const size = Number.parseInt(rest.slice(0, eol), 16);
    if (!Number.isFinite(size) || size <= 0) return out;
    out += rest.slice(eol + 2, eol + 2 + size);
    rest = rest.slice(eol + 2 + size + 2);
  }
}

// Send a raw HTTP/1.1 request so percent-encoding and Host headers reach the
// server byte-for-byte (fetch/undici would normalize some of them).
export function rawRequest(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(lines));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => {
      const split = data.indexOf('\r\n\r\n');
      const head = split === -1 ? data : data.slice(0, split);
      const rawBody = split === -1 ? '' : data.slice(split + 4);
      const body = /transfer-encoding:\s*chunked/i.test(head) ? dechunk(rawBody) : rawBody;
      const status = Number((head.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]);
      resolve({ status, head, body });
    });
    socket.on('error', reject);
    socket.setTimeout(10000, () => socket.destroy(new Error('raw request timed out')));
  });
}

export function httpRequest(port, method, target, { headers = {}, body } = {}) {
  const lines = Object.entries({ Host: `127.0.0.1:${port}`, Connection: 'close', ...headers });
  let text = `${method} ${target} HTTP/1.1\r\n`;
  for (const [name, value] of lines) text += `${name}: ${value}\r\n`;
  if (body !== undefined) {
    const payload = Buffer.from(body);
    text += `Content-Length: ${payload.length}\r\n`;
  }
  text += '\r\n';
  if (body !== undefined) text += body;
  return rawRequest(port, text);
}
