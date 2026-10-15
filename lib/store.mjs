// Persistent store for per-course, per-lesson progress.
// Backed by a single JSON file so it survives restarts with no database.

import fs from 'node:fs/promises';
import path from 'node:path';

export function progressStore(file) {
  let data = { courses: {} };
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') data = parsed;
    } catch {
      // no store yet
    }
    if (!data.courses || typeof data.courses !== 'object') data.courses = {};
  }

  async function save() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  }

  async function get() {
    await load();
    return data;
  }

  async function setLesson(courseId, lessonFile, status) {
    await load();
    const course = data.courses[courseId] || (data.courses[courseId] = { lessons: {} });
    if (!course.lessons) course.lessons = {};
    if (status === 'none') {
      delete course.lessons[lessonFile];
    } else {
      course.lessons[lessonFile] = { status, updatedAt: Date.now() };
    }
    await save();
    return data;
  }

  return { get, setLesson, file };
}
