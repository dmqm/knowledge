// The progress store used to treat any unreadable/corrupt file as an empty
// store, silently wiping what the user saw. The agreed behaviour is fail-open
// but visible: back the bad file up, continue empty, and report the event via
// /api/state. If the backup itself fails, the original must not be destroyed.
//
// These tests use fetch() rather than the raw helper: chunked JSON responses
// contain multibyte Chinese and the helper's de-chunker slices by characters.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { freePort, makeAppCopy, startServer } from './helpers.mjs';

const CORRUPT_JSON = '{"courses": {"demo": {"lessons": {';
const CORRUPT_RE = /进度文件损坏/;

const stateUrl = (port) => `http://127.0.0.1:${port}/api/state`;
const progressUrl = (port) => `http://127.0.0.1:${port}/api/progress`;

async function readState(port) {
  const res = await fetch(stateUrl(port));
  assert.equal(res.status, 200);
  return res.json();
}

async function withServer(progressText, fn) {
  const copy = await makeAppCopy();
  const { app } = copy;
  const dataDir = path.join(app, 'data');
  const progressFile = path.join(dataDir, 'progress.json');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(progressFile, progressText);

  const port = await freePort();
  const server = await startServer(app, port);
  try {
    return await fn({ app, dataDir, progressFile, port, server });
  } finally {
    await server.stop();
    await copy.cleanup();
  }
}

test('bad JSON: backup exists, /api/state warns, and progress writes still work', async () => {
  await withServer(CORRUPT_JSON, async ({ dataDir, progressFile, port }) => {
    const state = await readState(port);

    // Existing fields stay exactly as before (additive change only).
    assert.equal(state.authRequired, false);
    assert.equal(state.authed, true);
    assert.equal(typeof state.contentRoot, 'string');
    // New field carries a human-readable warning naming the backup.
    assert.equal(typeof state.progressWarning, 'string');
    assert.match(state.progressWarning, CORRUPT_RE);

    const backups = (await fs.readdir(dataDir)).filter((n) =>
      n.startsWith('progress.json.corrupt-'),
    );
    assert.equal(backups.length, 1);
    assert.ok(state.progressWarning.includes(backups[0]));
    assert.equal(await fs.readFile(path.join(dataDir, backups[0]), 'utf8'), CORRUPT_JSON);

    // A normal write after the reset works and persists valid JSON.
    const write = await fetch(progressUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ course: 'demo', file: '01.html', status: 'done' }),
    });
    assert.equal(write.status, 200);
    const onDisk = JSON.parse(await fs.readFile(progressFile, 'utf8'));
    assert.equal(onDisk.courses.demo.lessons['01.html'].status, 'done');
  });
});

test('structurally invalid JSON is quarantined the same way', async () => {
  const original = JSON.stringify({ courses: [] });
  await withServer(original, async ({ dataDir, progressFile, port }) => {
    const state = await readState(port);
    assert.match(state.progressWarning, CORRUPT_RE);

    const backups = (await fs.readdir(dataDir)).filter((n) =>
      n.startsWith('progress.json.corrupt-'),
    );
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(dataDir, backups[0]), 'utf8'), original);
    assert.deepEqual(JSON.parse(await fs.readFile(progressFile, 'utf8')), { courses: {} });
  });
});

test('after a successful repair a restart no longer reports corruption', async () => {
  const copy = await makeAppCopy();
  const { app } = copy;
  const dataDir = path.join(app, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'progress.json'), CORRUPT_JSON);

  try {
    const port = await freePort();
    const first = await startServer(app, port);
    try {
      assert.match((await readState(port)).progressWarning, CORRUPT_RE);
    } finally {
      await first.stop();
    }

    const port2 = await freePort();
    const second = await startServer(app, port2);
    try {
      assert.equal((await readState(port2)).progressWarning, null);
    } finally {
      await second.stop();
    }
  } finally {
    await copy.cleanup();
  }
});
