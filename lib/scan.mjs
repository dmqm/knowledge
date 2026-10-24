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

// Count readable length the way a Chinese reader thinks about it.
// Splitting on whitespace only works for space-separated languages: Chinese
// prose has no spaces, so "2513 汉字" collapsed into "244 词". Here each CJK
// character counts as one unit and each run of latin/digit characters counts
// as one word — which is what the "字数" label on the card actually promises.
function countUnits(text) {
  const t = String(text || '');
  let cjk = 0;
  let latin = 0;
  let inLatin = false;
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    const isCjk =
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
      (cp >= 0x3400 && cp <= 0x4dbf) || // Extension A
      (cp >= 0xf900 && cp <= 0xfaff) || // Compatibility Ideographs
      (cp >= 0x3040 && cp <= 0x30ff) || // Kana
      (cp >= 0xac00 && cp <= 0xd7af); // Hangul
    if (isCjk) {
      cjk += 1;
      inLatin = false;
      continue;
    }
    const isWordish = /[A-Za-z0-9]/.test(ch);
    if (isWordish) {
      if (!inLatin) latin += 1;
      inLatin = true;
    } else {
      inLatin = false;
    }
  }
  return cjk + latin;
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
        meta = { words: countUnits(stripTags(raw)) };
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

// Optional `categories.json` at the content root groups the home page:
//
//   { "groups": [
//       { "name": "财富与社会", "courses": ["duan-yongping", "inside-the-system"] }
//   ] }
//
// It is optional on purpose — without it every course falls into one group and
// the portal still works. Keeping it next to the content (not in config.json,
// which is gitignored) means the published static build gets the same groups.
async function readCategoryGroups(contentRoot) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(contentRoot, 'categories.json'), 'utf8'));
  } catch {
    return new Map();
  }
  const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
  const order = new Map();
  for (const [i, group] of groups.entries()) {
    const name = String(group && group.name ? group.name : '').trim();
    if (!name) continue;
    const ids = Array.isArray(group.courses) ? group.courses : [];
    for (const id of ids) order.set(String(id), { name, order: i });
  }
  return order;
}

export async function scanCourses(contentRoot) {
  let entries;
  try {
    entries = await fs.readdir(contentRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const groups = await readCategoryGroups(contentRoot);
  const courses = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const course = await readCourse(path.join(contentRoot, entry.name), entry.name);
    if (!course) continue;
    const group = groups.get(course.id);
    course.group = group ? group.name : '更多主题';
    course.groupOrder = group ? group.order : Number.MAX_SAFE_INTEGER;
    courses.push(course);
  }
  // Group order wins; inside a group the most recently touched topic is first.
  courses.sort((a, b) => a.groupOrder - b.groupOrder || b.mtime - a.mtime);
  return courses;
}

// Full-text search across every lesson, mission and learning record.
//
// The index is built once and reused until the content actually changes.
// Before, every keystroke re-read every file of every course from disk —
// ~1s per request on a laptop, and the phone fires one request per typed
// character.
//
// Two separate concerns, deliberately kept apart:
//   - the *signature* is a cheap `stat` walk. It must never read file bodies,
//     or the cache check costs more than the search it is supposed to save.
//   - the *index* is the expensive part, built only when the signature moved.
const searchIndexCache = new Map();

// Cheap: stats only, never opens a file.
async function contentSignature(contentRoot) {
  let newest = 0;
  const walk = async (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '_originals') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!/\.(html|md)$/i.test(entry.name)) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (stat) newest = Math.max(newest, stat.mtimeMs);
    }
  };
  await walk(contentRoot, 0);
  return newest;
}

async function buildSearchIndex(contentRoot, courses) {
  const index = [];
  for (const course of courses) {
    const dir = path.join(contentRoot, course.id);

    index.push({
      courseId: course.id,
      courseTitle: course.title,
      label: 'MISSION',
      kind: 'mission',
      url: null,
      text: course.mission.replace(/[#*`>]/g, ''),
    });

    for (const lesson of course.lessons) {
      const raw = await fs
        .readFile(path.join(dir, 'lessons', lesson.file), 'utf8')
        .catch(() => '');
      index.push({
        courseId: course.id,
        courseTitle: course.title,
        label: lesson.title,
        kind: 'lesson',
        url: lesson.url,
        text: stripTags(raw),
      });
    }

    for (const rec of course.records) {
      const raw = await fs
        .readFile(path.join(dir, 'learning-records', rec.file), 'utf8')
        .catch(() => '');
      index.push({
        courseId: course.id,
        courseTitle: course.title,
        label: rec.title,
        kind: 'record',
        url: rec.url,
        text: raw,
      });
    }
  }
  return index;
}

async function getSearchIndex(contentRoot) {
  const sig = await contentSignature(contentRoot);
  const hit = searchIndexCache.get(contentRoot);
  if (hit && hit.sig === sig) return hit.index;

  // Only when the signature actually moved do we pay for a full re-scan.
  const courses = await scanCourses(contentRoot);
  const index = await buildSearchIndex(contentRoot, courses);
  searchIndexCache.set(contentRoot, { sig, index });
  return index;
}

// How relevant is one document for this query? A hit in the title beats a
// hit buried in the body; more mentions beat one; an early mention beats a
// late one. Without this the results came back in course order, so the most
// on-topic lesson could sit below fifty weak matches.
function relevance(doc, q) {
  const label = String(doc.label || '').toLowerCase();
  const courseTitle = String(doc.courseTitle || '').toLowerCase();
  const text = String(doc.text || '');
  const lower = text.toLowerCase();

  let score = 0;
  if (label.includes(q)) score += 60;
  if (courseTitle.includes(q)) score += 30;
  if (label.toLowerCase().trim() === q) score += 40;

  let count = 0;
  let at = lower.indexOf(q);
  let first = at;
  while (at !== -1) {
    count += 1;
    at = lower.indexOf(q, at + q.length);
  }
  if (count === 0) return 0;
  score += Math.min(count, 10) * 8;
  if (first >= 0) score += Math.max(0, 20 - Math.floor(first / 120));

  return score;
}

export async function searchCourses(contentRoot, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const index = await getSearchIndex(contentRoot);
  const results = [];

  for (const doc of index) {
    const text = String(doc.text || '');
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 60);
    const snippet = `${idx > 60 ? '…' : ''}${text.slice(start, idx + q.length + 90)}${
      idx + q.length + 90 < text.length ? '…' : ''
    }`;
    results.push({
      courseId: doc.courseId,
      courseTitle: doc.courseTitle,
      label: doc.label,
      kind: doc.kind,
      url: doc.url,
      snippet: snippet.trim(),
      score: relevance(doc, q),
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 60);
}
