// The static search index must carry the same full text as the live server.
// It used to clip every document at 20000 chars, so a long lesson silently
// lost everything past that point while `/api/search` still matched it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { makeAppCopy } from './helpers.mjs';

let app;
let base;
let result;

const LONG = `BEGIN-MARK ${'A'.repeat(25000)} END-MARK`;

before(async () => {
  ({ app, base } = await makeAppCopy());
  const dir = path.join(app, 'courses', 'long');
  await fs.mkdir(path.join(dir, 'lessons'), { recursive: true });
  await fs.writeFile(path.join(dir, 'MISSION.md'), '# Long\n\nA long course.\n');
  await fs.writeFile(
    path.join(dir, 'lessons', '01.html'),
    `<!doctype html><title>Long One</title><p>${LONG}</p>`,
  );

  result = spawnSync(process.execPath, ['scripts/export.mjs'], {
    cwd: app,
    encoding: 'utf8',
    timeout: 120000,
  });
});

after(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

test('a lesson longer than 20000 chars is indexed in full', async () => {
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(
    await fs.readFile(path.join(app, 'dist', 'api', 'search-index.json'), 'utf8'),
  );
  const doc = index.find((d) => d.courseId === 'long' && d.kind === 'lesson');
  assert.ok(doc, 'long lesson is missing from the index');

  assert.ok(doc.text.length > 20000, `index truncated at ${doc.text.length} chars`);
  assert.ok(doc.text.includes('END-MARK'), 'text past the old 20000-char cut is missing');
  assert.ok(doc.text.includes(LONG), 'indexed text differs from the source body');
});
