// Config handling must fail closed.
//
// A missing config.json is fine (built-in defaults), but a file that exists and
// cannot be read/parsed used to be treated as "no config", which silently
// dropped the password and served /api/state as `authRequired:false`.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { freePort, makeAppCopy } from './helpers.mjs';

async function withApp(fn) {
  const { app, base, cleanup } = await makeAppCopy();
  try {
    return await fn(app);
  } finally {
    await cleanup();
  }
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of ['LC_HOST', 'LC_PORT', 'LC_PASSWORD', 'LC_CONTENT_ROOT']) delete env[key];
  return env;
}

function runToExit(app, timeout = 15000) {
  return spawnSync(process.execPath, ['server.mjs'], {
    cwd: app,
    encoding: 'utf8',
    timeout,
    env: cleanEnv(),
  });
}

async function waitFor(fn, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startAndWait(app, port, args = []) {
  const child = spawn(process.execPath, ['server.mjs', ...args], {
    cwd: app,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv(),
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  try {
    await waitFor(async () => {
      if (child.exitCode !== null) {
        throw new Error(`server exited early (${child.exitCode})\n${output}`);
      }
      try {
        await fetch(`http://127.0.0.1:${port}/api/state`);
        return true;
      } catch {
        return false;
      }
    }, 'server to listen');
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
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

test('malformed config.json aborts startup instead of disabling auth', async () => {
  await withApp(async (app) => {
    await fs.writeFile(path.join(app, 'config.json'), '{ "password": "secret", ');
    const res = runToExit(app);
    assert.notEqual(res.status, 0, 'server must not start with broken config');
    assert.match(res.stderr, /配置文件不是合法 JSON/, res.stderr);
  });
});

test('an unreadable config.json aborts startup', async () => {
  await withApp(async (app) => {
    // A directory named config.json makes readFile fail with EISDIR.
    await fs.mkdir(path.join(app, 'config.json'));
    const res = runToExit(app);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /无法读取配置文件/, res.stderr);
  });
});

test('illegal config field types abort startup', async () => {
  await withApp(async (app) => {
    await fs.writeFile(path.join(app, 'config.json'), JSON.stringify({ password: 123 }));
    const res = runToExit(app);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /password/, res.stderr);

    await fs.writeFile(path.join(app, 'config.json'), JSON.stringify({ port: 'abc' }));
    const res2 = runToExit(app);
    assert.notEqual(res2.status, 0);
    assert.match(res2.stderr, /port/, res2.stderr);
  });
});

test('no config.json still starts with built-in defaults (no password)', async () => {
  await withApp(async (app) => {
    const port = await freePort();
    const server = await startAndWait(app, port, ['--host', '127.0.0.1', '--port', String(port)]);
    try {
      const state = await fetch(`http://127.0.0.1:${port}/api/state`);
      assert.equal(state.status, 200);
      assert.equal((await state.json()).authRequired, false);
    } finally {
      await server.stop();
    }
  });
});

test('config with host 0.0.0.0 and a password keeps auth required', async () => {
  await withApp(async (app) => {
    const port = await freePort();
    await fs.writeFile(
      path.join(app, 'config.json'),
      JSON.stringify({ host: '0.0.0.0', port, password: 'secret', contentRoot: './courses' }),
    );

    const server = await startAndWait(app, port);
    try {
      const denied = await fetch(`http://127.0.0.1:${port}/api/state`);
      assert.equal(denied.status, 401, 'unauthenticated state must be rejected');

      const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'secret' }),
      });
      assert.equal(login.status, 200);
      const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
      assert.match(cookie, /^lc_session=/);

      const authed = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { Cookie: cookie },
      });
      assert.equal(authed.status, 200);
      assert.equal((await authed.json()).authRequired, true);

      assert.match(server.output, /密码保护:\s*已开启/, server.output);
    } finally {
      await server.stop();
    }
  });
});
