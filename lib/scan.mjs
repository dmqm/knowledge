// Scans the content root for `teach` workspaces and turns each one into a
// "course" the learning center can render.
//
// A `teach` workspace is any directory that contains a MISSION.md file or a
// `lessons/` folder. Layout produced by the teach skill:
//
//   <course>/
//     MISSION.md
//     RESOURCES.md
//     NOTES.md
//     lessons/*.html
//     reference/*.html
//     learning-records/*.md
//     assets/*

import fs from 'node:fs/promises';
import path from 'node:path';

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function htmlTitle(html, fallback) {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1].trim()) return t[1].trim();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1 && h1[1].trim()) return stripTags(h1[1]).slice(0, 120);
  const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (h2 && h2[1].trim()) return stripTags(h2[1]).slice(0, 120);
  return fallback;
}

function humanFromFilename(name) {
  return name
    .replace(/\.(html?|md)$/i, '')
    .replace(/^\d+[-_]?/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

export function slugify(input) {
  const base = String(input)
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || `course-${Date.now()}`;
}

function missionTitle(md, fallback) {
  const m = md.match(/^#\s+(.*)$/m);
  if (m) {
    return m[1].replace(/^Mission:\s*/i, '').trim() || fallback;
  }
  return fallback;
}

async function listDocs(dir, courseId, kind, ext, urlBase) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((n) => n.toLowerCase().endsWith(ext)).sort();
  const out = [];
  for (const file of files) {
    const full = path.join(dir, file);
    let title = humanFromFilename(file);
    let meta = {};
    if (ext === '.html') {
      try {
        const raw = await fs.readFile(full, 'utf8');
        title = htmlTitle(raw, title);
        meta = { words: stripTags(raw).split(/\s+/).filter(Boolean).length };
      } catch {
        // ignore unreadable file
      }
    } else if (ext === '.md') {
      try {
        const raw = await fs.readFile(full, 'utf8');
        const m = raw.match(/^#\s+(.*)$/m);
        if (m) title = m[1].trim();
      } catch {
        // ignore
      }
    }
    const stat = await fs.stat(full).catch(() => null);
    out.push({
      file,
      title,
      kind,
      url: `${urlBase}/${encodeURIComponent(courseId)}/${kind}/${encodeURIComponent(file)}`,
      mtime: stat ? stat.mtimeMs : 0,
      ...meta,
    });
  }
  return out;
}

export async function readCourse(dir, id) {
  const missionPath = path.join(dir, 'MISSION.md');
  const lessonsDir = path.join(dir, 'lessons');
  const hasMission = await exists(missionPath);
  const hasLessons = await exists(lessonsDir);
  if (!hasMission && !hasLessons) return null;

  let mission = '';
  if (hasMission) {
    mission = await fs.readFile(missionPath, 'utf8').catch(() => '');
  }

  const lessons = await listDocs(lessonsDir, id, 'lessons', '.html', '/files');
  const reference = await listDocs(path.join(dir, 'reference'), id, 'reference', '.html', '/files');
  const records = await listDocs(
    path.join(dir, 'learning-records'),
    id,
    'learning-records',
    '.md',
    '/files',
  );

  const resourcesPath = path.join(dir, 'RESOURCES.md');
  const notesPath = path.join(dir, 'NOTES.md');
  const hasResources = await exists(resourcesPath);
  const hasNotes = await exists(notesPath);

  const stat = await fs.stat(dir).catch(() => null);

  return {
    id,
    title: missionTitle(mission, id),
    mission,
    lessons,
    reference,
    records,
    hasResources,
    hasNotes,
    counts: {
      lessons: lessons.length,
      reference: reference.length,
      records: records.length,
    },
    mtime: stat ? stat.mtimeMs : 0,
  };
}

export async function scanCourses(contentRoot) {
  let entries;
  try {
    entries = await fs.readdir(contentRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const courses = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const course = await readCourse(path.join(contentRoot, entry.name), entry.name);
    if (course) courses.push(course);
  }
  courses.sort((a, b) => b.mtime - a.mtime);
  return courses;
}

// Full-text search across every lesson, mission and learning record.
export async function searchCourses(contentRoot, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const courses = await scanCourses(contentRoot);
  const results = [];

  const scanText = (courseTitle, label, text, url, kind, courseId) => {
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) return;
    const start = Math.max(0, idx - 60);
    const snippet = `${idx > 60 ? '…' : ''}${text.slice(start, idx + q.length + 90)}${
      idx + q.length + 90 < text.length ? '…' : ''
    }`;
    results.push({ courseId, courseTitle, label, kind, url, snippet: snippet.trim() });
  };

  for (const course of courses) {
    scanText(course.title, 'MISSION', course.mission.replace(/[#*`>]/g, ''), null, 'mission', course.id);
    for (const lesson of course.lessons) {
      const raw = await fs
        .readFile(path.join(contentRoot, course.id, 'lessons', lesson.file), 'utf8')
        .catch(() => '');
      scanText(course.title, lesson.title, stripTags(raw), lesson.url, 'lesson', course.id);
    }
    for (const rec of course.records) {
      const raw = await fs
        .readFile(path.join(contentRoot, course.id, 'learning-records', rec.file), 'utf8')
        .catch(() => '');
      scanText(course.title, rec.title, raw, rec.url, 'record', course.id);
    }
    if (results.length >= 60) break;
  }
  return results.slice(0, 60);
}
