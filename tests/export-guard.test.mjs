// Guard tests for scripts/export.mjs.
//
// Every run happens inside a temp copy of the app; the real repository is never
// a deletion target. Each rejected invocation must exit non-zero AND leave the
// whole tree untouched.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { makeAppCopy } from './helpers.mjs';

let app;
let base;

before(async () => {
  ({ app, base } = await makeAppCopy());
});

after(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function runExport(args) {
  return spawnSync(process.execPath, ['scripts/export.mjs', ...args], {
    cwd: app,
    encoding: 'utf8',
    timeout: 120000,
  });
}

async function treeSnapshot() {
  const paths = [
    'server.mjs',
    'victim.txt',
    'outside/secret.txt',
    'courses/demo/MISSION.md',
    'courses/demo/lessons/01.html',
    'public/index.html',
    'lib/store.mjs',
    'scripts/export.mjs',
  ];
  const out = {};
  for (const p of paths) out[p] = await fs.readFile(path.join(app, p), 'utf8');
  return out;
}

const badOuts = ['.', 'public', 'courses', 'lib', '..', './dist/..', 'data', 'public/nested'];

test('unsafe --out values are refused without deleting anything', async () => {
  const before = await treeSnapshot();
  for (const out of badOuts) {
    const res = runExport(['--out', out]);
    assert.notEqual(res.status, 0, `--out ${out} should fail`);
    assert.match(res.stderr, /拒绝导出/, `--out ${out} should explain: ${res.stderr}`);
    assert.deepEqual(await treeSnapshot(), before, `--out ${out} changed the tree`);
  }
});

test('an output dir that resolves through a link to the root is refused', async () => {
  const link = path.join(base, 'evil');
  try {
    await fs.symlink(app, link, 'junction');
  } catch {
    return; // no symlink privilege on this machine; covered by path checks
  }
  const before = await treeSnapshot();
  const res = runExport(['--out', '../evil']);
  assert.notEqual(res.status, 0);
  assert.deepEqual(await treeSnapshot(), before);
});

test('default export and an external --out still build a complete site', async () => {
  const def = runExport([]);
  assert.equal(def.status, 0, def.stderr);
  assert.match(def.stdout, /已导出 2 个主题 \/ 2 篇讲义/, def.stdout);
  for (const p of [
    'dist/index.html',
    'dist/assets/app.js',
    'dist/assets/config.js',
    'dist/site.webmanifest',
    'dist/api/courses.json',
    'dist/api/search-index.json',
    'dist/files/demo/MISSION.md',
    'dist/files/demo/lessons/01.html',
  ]) {
    await fs.access(path.join(app, p));
  }
  const config = await fs.readFile(path.join(app, 'dist', 'assets', 'config.js'), 'utf8');
  assert.match(config, /__LC_STATIC__\s*=\s*true/);
  const list = JSON.parse(await fs.readFile(path.join(app, 'dist', 'api', 'courses.json'), 'utf8'));
  assert.deepEqual(
    list.courses.map((c) => c.id).sort(),
    ['demo', 'doomed'],
  );

  const external = path.join(base, 'out-ok');
  const alt = runExport(['--out', external]);
  assert.equal(alt.status, 0, alt.stderr);
  await fs.access(path.join(external, 'index.html'));
  await fs.access(path.join(external, 'files', 'demo', 'lessons', '01.html'));

  const empty = path.join(base, 'out-empty');
  await fs.mkdir(empty, { recursive: true });
  const alt2 = runExport(['--out', empty]);
  assert.equal(alt2.status, 0, alt2.stderr);
  await fs.access(path.join(empty, 'index.html'));
});

test('a --content that is not a directory fails instead of exporting nothing', async () => {
  const outFile = path.join(base, 'out-bad-content-file');
  const fileRoot = runExport(['--content', 'victim.txt', '--out', outFile]);
  assert.notEqual(fileRoot.status, 0, 'a file as content root must fail');
  assert.match(fileRoot.stderr, /不是目录/, fileRoot.stderr);

  const outMissing = path.join(base, 'out-bad-content-missing');
  const missing = runExport(['--content', './no-such-content', '--out', outMissing]);
  assert.notEqual(missing.status, 0, 'a missing content root must fail');
  assert.match(missing.stderr, /不存在/, missing.stderr);

  // The failed builds must not have published an empty list anywhere.
  await assert.rejects(fs.access(path.join(outFile, 'api', 'courses.json')));
  await assert.rejects(fs.access(path.join(outMissing, 'api', 'courses.json')));
});

test('unreadable missions/lessons/records fail the build instead of exporting empty', async () => {
  const cases = [
    // MISSION.md is a directory: the course metadata cannot be read.
    { id: 'broken-mission', setup: (dir) => fs.mkdir(path.join(dir, 'MISSION.md'), { recursive: true }) },
    // lessons/01.html is a directory: the scan lists it but cannot read it.
    { id: 'broken-lesson', setup: (dir) => fs.mkdir(path.join(dir, 'lessons', '01.html'), { recursive: true }) },
    // learning-records exists but is a file, not a readable directory.
    {
      id: 'broken-records',
      setup: async (dir) => {
        await fs.mkdir(path.join(dir, 'lessons'), { recursive: true });
        await fs.writeFile(path.join(dir, 'learning-records'), 'not a dir');
      },
    },
    // A listed record is a directory: it cannot be read as markdown.
    {
      id: 'broken-record-file',
      setup: async (dir) => {
        await fs.mkdir(path.join(dir, 'lessons'), { recursive: true });
        await fs.mkdir(path.join(dir, 'learning-records', '01.md'), { recursive: true });
      },
    },
  ];

  for (const { id, setup } of cases) {
    const dir = path.join(app, 'courses', id);
    try {
      await fs.mkdir(dir, { recursive: true });
      if (id !== 'broken-mission') {
        await fs.writeFile(path.join(dir, 'MISSION.md'), `# ${id}\n`);
      }
      await setup(dir);
      const res = runExport([]);
      assert.notEqual(res.status, 0, `${id} must fail`);
      assert.match(res.stderr, /无法读取/, `${id}: ${res.stderr}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  // The tree is healthy again: the normal export still works.
  const ok = runExport([]);
  assert.equal(ok.status, 0, ok.stderr);
});
