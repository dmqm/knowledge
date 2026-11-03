// Unit tests for lib/store.mjs: keys must be validated and maps must not have
// a prototype, so `__proto__` cannot rewrite Object.prototype for the process.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { corruptBackupName, progressStore } from '../lib/store.mjs';

let dir;
let file;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-store-'));
  file = path.join(dir, 'progress.json');
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('valid progress round-trips', async () => {
  const store = progressStore(file);
  const data = await store.setLesson('demo', '01.html', 'done');
  assert.equal(data.courses.demo.lessons['01.html'].status, 'done');
  const again = progressStore(file);
  const loaded = await again.get();
  assert.equal(loaded.courses.demo.lessons['01.html'].status, 'done');
});

test('unsafe course ids and lesson files throw', async () => {
  const store = progressStore(file);
  const badCourses = ['__proto__', 'constructor', 'prototype', '..', '.', 'a/b', 'a\\b', '', 'x\u0000y'];
  if (process.platform === 'win32') badCourses.push('CON', 'nul.txt', 'demo.');
  for (const course of badCourses) {
    await assert.rejects(store.setLesson(course, '01.html', 'done'), TypeError, course);
  }
  const badFiles = ['__proto__', 'constructor', 'prototype', '..', '../a.html', 'a/b', 'a\\b', 'x\u0000y', ''];
  if (process.platform === 'win32') badFiles.push('nul.txt', '01.html.');
  for (const lessonFile of badFiles) {
    await assert.rejects(store.setLesson('demo', lessonFile, 'done'), TypeError, lessonFile);
  }
  await assert.rejects(store.setLesson('demo', '01.html', 'bogus'), TypeError);
  assert.equal(Object.prototype.lessons, undefined);
  assert.equal({}.lessons, undefined);
});

test('two concurrent first reads both see the persisted data', async () => {
  const conc = path.join(dir, 'first-read.json');
  await fs.writeFile(conc, JSON.stringify({ courses: { demo: { lessons: { '01.html': { status: 'done' } } } } }));

  const store = progressStore(conc);
  const [a, b] = await Promise.all([store.get(), store.get()]);
  assert.equal(a.courses.demo.lessons['01.html'].status, 'done');
  assert.equal(b.courses.demo.lessons['01.html'].status, 'done');
});

test('20 concurrent writes lose nothing and keep memory and disk identical', async () => {
  const conc = path.join(dir, 'concurrent.json');
  const store = progressStore(conc);
  const courses = Array.from({ length: 20 }, (_, i) => `course-${String(i).padStart(2, '0')}`);

  // Interleave reads with the writes: reads used to race the initial load.
  const tasks = [];
  for (const course of courses) {
    tasks.push(store.setLesson(course, '01.html', 'done'));
    tasks.push(store.get());
  }
  await Promise.all(tasks);

  const disk = JSON.parse(await fs.readFile(conc, 'utf8'));
  assert.deepEqual(Object.keys(disk.courses).sort(), [...courses].sort());
  for (const course of courses) {
    assert.equal(disk.courses[course].lessons['01.html'].status, 'done', course);
  }

  const mem = await store.get();
  assert.deepEqual(JSON.parse(JSON.stringify(mem)), disk);

  const tmp = (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(tmp, [], 'temporary files were left behind');

  // A fresh process-level store sees exactly what the concurrent run wrote.
  const again = await progressStore(conc).get();
  assert.deepEqual(JSON.parse(JSON.stringify(again)), disk);
});

test('20 concurrent writes to the same key all settle without EPERM/corruption', async () => {
  const conc = path.join(dir, 'same-key.json');
  const store = progressStore(conc);
  await Promise.all(Array.from({ length: 20 }, () => store.setLesson('demo', '01.html', 'done')));

  const disk = JSON.parse(await fs.readFile(conc, 'utf8'));
  assert.equal(disk.courses.demo.lessons['01.html'].status, 'done');
  const tmp = (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(tmp, []);
});

test('a poisoned store file is ignored, not merged', async () => {
  const poisoned = path.join(dir, 'poisoned.json');
  await fs.writeFile(
    poisoned,
    JSON.stringify({
      courses: {
        // computed keys make these real own properties, like JSON.parse would
        ['__proto__']: { lessons: { ['__proto__']: { status: 'done' } } },
        demo: { lessons: { '01.html': { status: 'done' }, ['__proto__']: { status: 'done' } } },
      },
    }),
  );

  const store = progressStore(poisoned);
  const data = await store.get();
  assert.equal(Object.prototype.lessons, undefined);
  assert.equal({}.lessons, undefined);
  assert.deepEqual(Object.keys(data.courses), ['demo']);
  assert.deepEqual(Object.keys(data.courses.demo.lessons), ['01.html']);
  // A valid shape with junk keys is cleaned, not treated as corruption.
  assert.equal(await store.getWarning(), null);
  assert.deepEqual(
    (await fs.readdir(dir)).filter((n) => n.startsWith('poisoned.json.corrupt-')),
    [],
  );
});

// --- corruption is visible, backed up, and recoverable ----------------------

test('bad JSON is backed up, reported, and writes keep working', async () => {
  const f = path.join(dir, 'bad-json.json');
  const original = '{"courses": {"demo": {';
  await fs.writeFile(f, original);

  const store = progressStore(f);
  const data = await store.get();
  assert.deepEqual(Object.keys(data.courses), []);

  const warning = await store.getWarning();
  assert.match(warning, /进度文件损坏/);
  const backups = (await fs.readdir(dir)).filter((n) => n.startsWith('bad-json.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.match(warning, new RegExp(backups[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // The original bytes are recoverable from the backup.
  assert.equal(await fs.readFile(path.join(dir, backups[0]), 'utf8'), original);
  // The live file was reset to a valid empty store rather than left corrupt.
  assert.deepEqual(JSON.parse(await fs.readFile(f, 'utf8')), { courses: {} });

  const written = await store.setLesson('demo', '01.html', 'done');
  assert.equal(written.courses.demo.lessons['01.html'].status, 'done');
  const onDisk = JSON.parse(await fs.readFile(f, 'utf8'));
  assert.equal(onDisk.courses.demo.lessons['01.html'].status, 'done');

  // A fresh store reads the repaired file and reports nothing.
  const again = progressStore(f);
  assert.equal(await again.getWarning(), null);
  assert.equal((await again.get()).courses.demo.lessons['01.html'].status, 'done');
});

test('a structurally invalid store (courses is an array) is treated as corrupt', async () => {
  const f = path.join(dir, 'bad-shape.json');
  const original = JSON.stringify({ courses: [] });
  await fs.writeFile(f, original);

  const store = progressStore(f);
  assert.deepEqual(Object.keys((await store.get()).courses), []);
  assert.match(await store.getWarning(), /进度文件损坏/);
  const backups = (await fs.readdir(dir)).filter((n) => n.startsWith('bad-shape.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(dir, backups[0]), 'utf8'), original);
});

test('when the backup fails the corrupt file is left untouched and writes are refused', async () => {
  const f = path.join(dir, 'no-backup.json');
  const original = '{ definitely not json';
  await fs.writeFile(f, original);

  const denied = Object.assign(new Error('backup denied'), { code: 'EACCES' });
  const store = progressStore(f, {
    copyFile: async () => {
      throw denied;
    },
  });

  assert.deepEqual(Object.keys((await store.get()).courses), []);
  const warning = await store.getWarning();
  assert.match(warning, /无法自动备份/);
  assert.match(warning, /只读/);

  await assert.rejects(store.setLesson('demo', '01.html', 'done'), /只读/);
  // Neither the original nor a backup was touched.
  assert.equal(await fs.readFile(f, 'utf8'), original);
  assert.deepEqual(
    (await fs.readdir(dir)).filter((n) => n.startsWith('no-backup.json.corrupt-')),
    [],
  );
});

test('a real filesystem backup failure also leaves the original untouched', async () => {
  const f = path.join(dir, 'fs-backup-fails.json');
  const original = '{not json either';
  await fs.writeFile(f, original);
  const ts = Date.parse('2026-01-02T03:04:05.678Z');
  const backupPath = corruptBackupName(f, ts);
  // A directory sitting on the backup path makes copyFile fail for real.
  await fs.mkdir(backupPath);

  try {
    const store = progressStore(f, { now: () => ts });
    assert.deepEqual(Object.keys((await store.get()).courses), []);
    assert.match(await store.getWarning(), /无法自动备份/);
    await assert.rejects(store.setLesson('demo', '01.html', 'done'), /只读/);
    assert.equal(await fs.readFile(f, 'utf8'), original);
    assert.equal((await fs.stat(backupPath)).isDirectory(), true);
  } finally {
    await fs.rm(backupPath, { recursive: true, force: true });
  }
});

test('a missing store is empty and produces no warning', async () => {
  const f = path.join(dir, 'never-written.json');
  const store = progressStore(f);
  assert.deepEqual(Object.keys((await store.get()).courses), []);
  assert.equal(await store.getWarning(), null);
});
