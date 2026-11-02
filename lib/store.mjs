// Persistent store for per-course, per-lesson progress.
// Backed by a single JSON file so it survives restarts with no database.
//
// Keys are validated and maps are created with no prototype: a course id of
// `__proto__` used to rewrite `Object.prototype` for the whole process.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isSafeCourseId, isSafePathSegment } from './safe-path.mjs';

const STATUSES = ['done', 'none'];

function emptyData() {
  return { courses: Object.create(null) };
}

function normalizeLesson(value) {
  if (!value || typeof value !== 'object') return null;
  if (!STATUSES.includes(value.status) || value.status === 'none') return null;
  return { status: value.status, updatedAt: Number(value.updatedAt) || 0 };
}

// Rebuild loaded JSON into validated, prototype-free maps. Unknown or unsafe
// keys (older hand-edited files, or a poisoned store) are dropped.
function normalize(parsed) {
  const out = emptyData();
  if (!parsed || typeof parsed !== 'object') return out;
  const courses = parsed.courses;
  if (!courses || typeof courses !== 'object') return out;
  for (const courseId of Object.keys(courses)) {
    if (!isSafeCourseId(courseId)) continue;
    const entry = courses[courseId];
    if (!entry || typeof entry !== 'object') continue;
    const lessons = Object.create(null);
    const source = entry.lessons;
    if (source && typeof source === 'object') {
      for (const file of Object.keys(source)) {
        if (!isSafePathSegment(file)) continue;
        const lesson = normalizeLesson(source[file]);
        if (lesson) lessons[file] = lesson;
      }
    }
    out.courses[courseId] = { lessons };
  }
  return out;
}

export function progressStore(file) {
  let data = emptyData();
  let loaded = false;
  // Every operation touches the same in-memory map and the same file, so they
  // must run one at a time. Before this, two concurrent `load()` calls could
  // each return an empty snapshot (one overwrote the other) and two concurrent
  // `save()` calls shared `<file>.tmp`, so one rename hit EPERM while the
  // later write silently replaced the earlier one.
  let tail = Promise.resolve();

  function serialize(task) {
    const result = tail.then(task);
    // A failed task must not poison the queue: keep the chain resolved while
    // the rejection still reaches the caller through `result`.
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await fs.readFile(file, 'utf8');
      data = normalize(JSON.parse(raw));
    } catch {
      // no store yet
      data = emptyData();
    }
  }

  async function save() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Unique temp name per write: a shared `.tmp` made concurrent saves clobber
    // each other; rename keeps the swap atomic for readers.
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2));
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async function get() {
    return serialize(async () => {
      await loadOnce();
      return data;
    });
  }

  async function setLesson(courseId, lessonFile, status) {
    if (!isSafeCourseId(courseId)) throw new TypeError('invalid course id');
    if (!isSafePathSegment(lessonFile)) throw new TypeError('invalid lesson file');
    if (!STATUSES.includes(status)) throw new TypeError('invalid status');
    return serialize(async () => {
      await loadOnce();
      let course = data.courses[courseId];
      if (!course) {
        course = { lessons: Object.create(null) };
        data.courses[courseId] = course;
      }
      if (!course.lessons) course.lessons = Object.create(null);
      if (status === 'none') {
        delete course.lessons[lessonFile];
      } else {
        course.lessons[lessonFile] = { status, updatedAt: Date.now() };
      }
      await save();
      return data;
    });
  }

  return { get, setLesson, file };
}
