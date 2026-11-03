// Regression tests for the /files/ static handler.
//
// A link (symlink/junction) inside `courses/` used to pass the string prefix
// check and let the server read files outside the content root. The handler now
// resolves the real path and rejects anything that leaves the root.
//
// Everything runs in a throwaway copy of the app; no links are created in the
// real repository.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { freePort, httpRequest, makeAppCopy, startServer } from './helpers.mjs';

const TRICKY = '第 1 讲 #1 & 100% 完成.html';
const TRICKY_BODY = '<!doctype html><title>Tricky</title><p>中文 # 空格 100%</p>';
const DEEP_DIR = '深层 dir';
const DEEP_FILE = '笔记 02.md';
const DEEP_BODY = '# 深层笔记\n\ndeep content\n';

let copy;
let app;
let port;
let server;

before(async () => {
  copy = await makeAppCopy();
  app = copy.app;

  await fs.writeFile(path.join(app, 'courses', 'demo', 'lessons', TRICKY), TRICKY_BODY);
  await fs.mkdir(path.join(app, 'courses', 'demo', 'lessons', DEEP_DIR), { recursive: true });
  await fs.writeFile(
    path.join(app, 'courses', 'demo', 'lessons', DEEP_DIR, DEEP_FILE),
    DEEP_BODY,
  );

  port = await freePort();
  server = await startServer(app, port);
});

after(async () => {
  await server?.stop();
  await copy?.cleanup();
});

const encoded = (rel) => rel.split('/').map(encodeURIComponent).join('/');

test('normal files survive URL encoding: CJK, spaces, #, %, and deep paths', async () => {
  const cases = [
    [`/files/demo/lessons/${encoded(TRICKY)}`, TRICKY_BODY],
    [`/files/demo/lessons/${encoded(`${DEEP_DIR}/${DEEP_FILE}`)}`, DEEP_BODY],
    ['/files/demo/MISSION.md', '# Demo\n\nA test course.\n'],
  ];
  for (const [target, body] of cases) {
    const res = await httpRequest(port, 'GET', target);
    assert.equal(res.status, 200, `${target} -> ${res.status}`);
    assert.equal(res.body, body, `${target} body mismatch`);
  }

  // The public assets route goes through the same helper and must stay intact.
  const asset = await httpRequest(port, 'GET', '/assets/app.js');
  assert.equal(asset.status, 200);
  assert.match(asset.body, /Learning Center/);
});

test('traversal attempts and missing paths are 404, never 500 and never leak', async () => {
  const targets = [
    '/files/..%5Coutside%5Csecret.txt',
    '/files/demo%2F..%2F..%2Foutside%2Fsecret.txt',
    '/files/%2e%2e/outside/secret.txt',
    '/files/%00',
    '/files/demo/lessons/nope.html',
    '/files/demo/lessons/',
    '/files/demo',
    '/files/',
  ];
  for (const target of targets) {
    const res = await httpRequest(port, 'GET', target);
    assert.equal(res.status, 404, `${target} -> ${res.status}`);
    assert.ok(!res.body.includes('TOP-SECRET'), `${target} leaked content`);
  }

  // Malformed percent-encoding is a bad request, never a 500 or a crash.
  const malformed = await httpRequest(port, 'GET', '/files/%E0%A4%A');
  assert.ok([400, 404].includes(malformed.status), `malformed -> ${malformed.status}`);
});

async function tryLink(type, target, linkPath) {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (err) {
    // Creating file symlinks on Windows needs developer mode / elevation.
    if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(err.code)) return false;
    throw err;
  }
}

test('links inside courses cannot read outside: external dir, external file, broken', async (t) => {
  const outside = path.join(app, 'outside');
  const dirLink = path.join(app, 'courses', 'escape-dir');
  const fileLink = path.join(app, 'courses', 'escape-file');
  const brokenLink = path.join(app, 'courses', 'escape-broken');

  // 1. A directory link/junction pointing at a sibling of courses/.
  assert.ok(await tryLink('junction', outside, dirLink), 'could not create directory link');
  let res = await httpRequest(port, 'GET', '/files/escape-dir/secret.txt');
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes('TOP-SECRET'));

  // 2. A link whose target is an external *file*. Windows only allows this when
  //    developer mode is on; fall back to the same directory target, which
  //    still proves the realpath containment (the file resolves outside).
  const directFileLink = await tryLink('file', path.join(outside, 'secret.txt'), fileLink);
  if (directFileLink) {
    res = await httpRequest(port, 'GET', '/files/escape-file');
  } else {
    t.diagnostic('file symlinks unavailable (Windows developer mode off); using a junction');
    assert.ok(await tryLink('junction', outside, fileLink), 'could not create fallback link');
    res = await httpRequest(port, 'GET', '/files/escape-file/secret.txt');
  }
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes('TOP-SECRET'));

  // 3. A broken link: the target does not exist, so it must 404 (not crash).
  const directBroken = await tryLink('file', path.join(outside, 'missing.txt'), brokenLink);
  if (!directBroken) {
    assert.ok(
      await tryLink('junction', path.join(outside, 'missing-dir'), brokenLink),
      'could not create broken link',
    );
  }
  for (const target of ['/files/escape-broken', '/files/escape-broken/anything.txt']) {
    res = await httpRequest(port, 'GET', target);
    assert.equal(res.status, 404, `${target} -> ${res.status}`);
  }

  // The process is still healthy after all of the above.
  const health = await httpRequest(port, 'GET', '/api/state');
  assert.equal(health.status, 200);
  assert.equal(server.child.exitCode, null);
});
