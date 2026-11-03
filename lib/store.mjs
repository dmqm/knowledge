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

// A store file is only usable when it is a JSON object with an object
// `courses` map. Anything else (bad JSON, `[]`, `null`, `{"courses":[]}`) is
// treated as corruption instead of silently becoming an empty store.
function isValidShape(parsed) {
  return (
    !!parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    !!parsed.courses &&
    typeof parsed.courses === 'object' &&
    !Array.isArray(parsed.courses)
  );
}

// Windows filenames reject `:`; ISO-8601 with those characters swapped for `-`
// stays readable and works on every platform.
export function corruptBackupName(file, timestamp) {
  const stamp = new Date(timestamp).toISOString().replace(/[:.]/g, '-');
  return `${file}.corrupt-${stamp}`;
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

export function progressStore(file, { now = Date.now, copyFile = fs.copyFile } = {}) {
  let data = emptyData();
  let loaded = false;
  // Set when corruption was detected but the bad file could not be backed up.
  // In that state the only safe behaviour is to keep the file untouched; the
  // in-memory store stays empty and writes are refused.
  let readOnly = false;
  let warning = null;
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

  // Copy the unusable file aside and immediately persist the empty store, so a
  // restart does not find (and re-quarantine) the same corruption. Returns the
  // backup's name for the user-facing warning.
  async function quarantine() {
    const backup = corruptBackupName(file, now());
    await copyFile(file, backup);
    try {
      await save();
    } catch {
      // The backup already secured the data; the next successful write retries.
    }
    return path.basename(backup);
  }

  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        data = emptyData();
        return;
      }
      // Unreadable is not the same as absent: keep the file, go read-only.
      data = emptyData();
      readOnly = true;
      warning = `进度文件无法读取（${err.code || err.message}），当前为空白进度`;
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (isValidShape(parsed)) {
      data = normalize(parsed);
      return;
    }

    data = emptyData();
    try {
      const backup = await quarantine();
      warning = `进度文件损坏，已备份为 ${backup}，当前为空白进度`;
    } catch (err) {
      readOnly = true;
      warning = `进度文件损坏，无法自动备份（${err.code || err.message}），已切换为只读，当前为空白进度`;
    }
  }

  async function save() {
    if (readOnly) {
      throw new Error('进度文件损坏且无法备份，已切换为只读');
    }
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

  // Corruption is surfaced through /api/state; null means "nothing to report".
  async function getWarning() {
    return serialize(async () => {
      await loadOnce();
      return warning;
    });
  }

  async function setLesson(courseId, lessonFile, status) {
    if (!isSafeCourseId(courseId)) throw new TypeError('invalid course id');
    if (!isSafePathSegment(lessonFile)) throw new TypeError('invalid lesson file');
    if (!STATUSES.includes(status)) throw new TypeError('invalid status');
    return serialize(async () => {
      await loadOnce();
      if (readOnly) throw new Error('进度文件损坏且无法备份，已切换为只读');
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

  return { get, getWarning, setLesson, file };
}
