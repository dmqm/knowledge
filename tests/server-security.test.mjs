// Security regression tests for server.mjs:
//   1. course API path traversal (read + delete)
//   2. malformed Host headers must not kill the process
//   3. progress API prototype pollution / unknown course / traversal-y file

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { freePort, httpRequest, makeAppCopy, startServer } from './helpers.mjs';

let app;
let port;
let server;

before(async () => {
  ({ app } = await makeAppCopy());
  port = await freePort();
  server = await startServer(app, port);
});

after(async () => {
  await server?.stop();
  await app && (await fs.rm(path.dirname(app), { recursive: true, force: true }));
});

const rejected = (status) => status === 400 || status === 404;

async function snapshot() {
  return {
    victim: await fs.readFile(path.join(app, 'victim.txt'), 'utf8'),
    secret: await fs.readFile(path.join(app, 'outside', 'secret.txt'), 'utf8'),
  };
}

test('GET /api/courses/:id rejects traversal, absolute and NUL variants', async () => {
  const before = await snapshot();
  const variants = [
    '/api/courses/..%2Foutside',
    '/api/courses/..%5Coutside',
    '/api/courses/%2E%2E%2Foutside',
    '/api/courses/..%2F..%2Foutside',
    '/api/courses/demo%2F..%2F..%2Foutside',
    '/api/courses/C%3A%5CWindows%5Cwin.ini',
    '/api/courses/%2Fetc%2Fpasswd',
    '/api/courses/..%00',
    '/api/courses/%00',
    '/api/courses/..',
    '/api/courses/.trash',
    '/api/courses/CON',
    '/api/courses/demo%20',
    '/api/courses/%E0%A4%A',
  ];
  for (const target of variants) {
    const res = await httpRequest(port, 'GET', target);
    assert.ok(rejected(res.status), `${target} -> ${res.status}`);
    assert.ok(!res.body.includes('TOP-SECRET'), `${target} leaked content`);
  }
  assert.deepEqual(await snapshot(), before);
});

test('DELETE /api/courses/:id cannot move files from outside the content root', async () => {
  const before = await snapshot();
  const variants = [
    '/api/courses/..%2Fvictim.txt',
    '/api/courses/..%5Cvictim.txt',
    '/api/courses/%2E%2E%2Fvictim.txt',
    '/api/courses/..%2F..%2Fvictim.txt',
    '/api/courses/C%3A%5CWindows',
    '/api/courses/%00',
  ];
  for (const target of variants) {
    const res = await httpRequest(port, 'DELETE', target);
    assert.ok(rejected(res.status), `${target} -> ${res.status}`);
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(await fs.readFile(path.join(app, 'victim.txt'), 'utf8'), 'do-not-move');
  await assert.rejects(fs.access(path.join(app, 'courses', 'victim.txt')));
});

test('GET and DELETE still work for a legitimate course id', async () => {
  const got = await httpRequest(port, 'GET', '/api/courses/demo');
  assert.equal(got.status, 200);
  assert.equal(JSON.parse(got.body).course.id, 'demo');

  const unknown = await httpRequest(port, 'DELETE', '/api/courses/nope');
  assert.equal(unknown.status, 404);

  const del = await httpRequest(port, 'DELETE', '/api/courses/doomed');
  assert.equal(del.status, 200);
  assert.match(JSON.parse(del.body).movedTo, /^\.trash[\\/]/);
  const trash = await fs.readdir(path.join(app, 'courses', '.trash'));
  assert.equal(trash.length, 1);
});

test('malformed Host headers get 400 and leave the process alive', async () => {
  const badHosts = ['[', '', 'a b', '[::1', 'localhost:99999999'];
  for (const host of badHosts) {
    const res = await httpRequest(port, 'GET', '/api/state', {
      headers: { Host: host },
    });
    assert.equal(res.status, 400, `Host: ${JSON.stringify(host)} -> ${res.status}`);
  }
  const health = await httpRequest(port, 'GET', '/api/state');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).authRequired, false);
  assert.equal(server.child.exitCode, null);
});

test('progress API rejects prototype keys, unknown courses and bad files', async () => {
  const bad = [
    { course: '__proto__', file: '01.html', status: 'done' },
    { course: 'constructor', file: '01.html', status: 'done' },
    { course: 'prototype', file: '01.html', status: 'done' },
    { course: 'nope', file: '01.html', status: 'done' },
    { course: 'demo', file: '../victim.txt', status: 'done' },
    { course: 'demo', file: '..\\victim.txt', status: 'done' },
    { course: 'demo', file: '__proto__', status: 'done' },
    { course: 'demo', file: '02.html', status: 'done' },
    { course: 'demo', file: '01.html', status: 'bogus' },
    { course: '', file: '', status: '' },
  ];
  for (const payload of bad) {
    const res = await httpRequest(port, 'POST', '/api/progress', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.ok(rejected(res.status), `${JSON.stringify(payload)} -> ${res.status}`);
  }
  assert.equal(Object.prototype.lessons, undefined);
  assert.equal({}.lessons, undefined);

  const ok = await httpRequest(port, 'POST', '/api/progress', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ course: 'demo', file: '01.html', status: 'done' }),
  });
  assert.equal(ok.status, 200);
  const body = JSON.parse(ok.body);
  assert.equal(body.ok, true);
  assert.equal(body.lessons['01.html'].status, 'done');

  const raw = await fs.readFile(path.join(app, 'data', 'progress.json'), 'utf8');
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.ok(!raw.includes(key), `store contains ${key}`);
  }
  const stored = JSON.parse(raw);
  assert.ok(Object.keys(stored.courses).includes('demo'));
  assert.ok(!Object.keys(stored.courses).includes('__proto__'));

  const cleared = await httpRequest(port, 'POST', '/api/progress', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ course: 'demo', file: '01.html', status: 'none' }),
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(JSON.parse(cleared.body).lessons, {});
});
