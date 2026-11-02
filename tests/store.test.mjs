// Unit tests for lib/store.mjs: keys must be validated and maps must not have
// a prototype, so `__proto__` cannot rewrite Object.prototype for the process.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { progressStore } from '../lib/store.mjs';

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
});
