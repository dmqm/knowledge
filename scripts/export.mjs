// Builds a static, read-only copy of the learning center into dist/.
//
//   node scripts/export.mjs [--content ./courses] [--out ./dist]
//
// It reuses the very same scan / markdown helpers as server.mjs, so the
// published site and the live server stay in sync. No third-party deps.
//
// The output is what GitHub Pages serves: a plain folder of HTML / CSS / JS
// plus JSON files the front-end reads instead of the JSON API. Progress is
// kept in the browser (localStorage), so nothing here is writable.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdown } from '../lib/md.mjs';
import { scanCourses, exists } from '../lib/scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- config ----

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return fallback;
}

const contentRoot = path.resolve(root, arg('content', process.env.LC_CONTENT_ROOT || './courses'));
const outDir = path.resolve(root, arg('out', process.env.LC_OUT || './dist'));
const publicRoot = path.join(root, 'public');

// Chars kept per document in the search index. Keeps the payload small while
// still covering whole lessons.
const TEXT_LIMIT = 20000;

// --------------------------------------------------------------- helpers ----

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text, limit = TEXT_LIMIT) {
  const t = String(text || '');
  return t.length > limit ? t.slice(0, limit) : t;
}

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2));
}

async function copyFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

// Skip editor backups and dotfiles when mirroring a course.
function isPublishable(name) {
  return !name.startsWith('.') && !name.endsWith('.bak');
}

async function copyDir(src, dest) {
  let entries;
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!isPublishable(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

// ----------------------------------------------------------------- build ----

// The per-course detail payload. Mirrors the `course` half of server.mjs's
// GET /api/courses/:id (no progress — the browser owns that).
async function buildCourseJson(dir, course) {
  const [resourcesRaw, notesRaw] = await Promise.all([
    course.hasResources ? fs.readFile(path.join(dir, 'RESOURCES.md'), 'utf8').catch(() => '') : '',
    course.hasNotes ? fs.readFile(path.join(dir, 'NOTES.md'), 'utf8').catch(() => '') : '',
  ]);

  const records = [];
  for (const rec of course.records) {
    const raw = await fs.readFile(path.join(dir, 'learning-records', rec.file), 'utf8').catch(() => '');
    records.push({ ...rec, html: renderMarkdown(raw) });
  }

  return {
    course: {
      id: course.id,
      title: course.title,
      missionTitle: course.title,
      missionHtml: renderMarkdown(course.mission),
      resourcesHtml: resourcesRaw ? renderMarkdown(resourcesRaw) : '',
      notesHtml: notesRaw ? renderMarkdown(notesRaw) : '',
      hasResources: course.hasResources,
      hasNotes: course.hasNotes,
      lessons: course.lessons,
      reference: course.reference,
      records,
      counts: course.counts,
    },
  };
}

// The list payload. `done` is recomputed in the browser from localStorage, so
// we ship the lesson file names for it to count against.
function courseSummary(course) {
  const lessons = course.lessons;
  return {
    id: course.id,
    title: course.title,
    group: course.group || '更多主题',
    counts: course.counts,
    done: 0,
    total: lessons.length,
    lessons: lessons.map((l) => l.file),
    lastLesson: lessons.length ? lessons[lessons.length - 1].file : null,
    mtime: course.mtime,
  };
}

async function buildSearchIndex(courses) {
  const index = [];
  for (const course of courses) {
    const dir = path.join(contentRoot, course.id);

    index.push({
      courseId: course.id,
      courseTitle: course.title,
      label: 'MISSION',
      kind: 'mission',
      url: null,
      text: clip(course.mission.replace(/[#*`>]/g, '')),
    });

    for (const lesson of course.lessons) {
      const raw = await fs.readFile(path.join(dir, 'lessons', lesson.file), 'utf8').catch(() => '');
      index.push({
        courseId: course.id,
        courseTitle: course.title,
        label: lesson.title,
        kind: 'lesson',
        url: lesson.url,
        text: clip(stripTags(raw)),
      });
    }

    for (const rec of course.records) {
      const raw = await fs.readFile(path.join(dir, 'learning-records', rec.file), 'utf8').catch(() => '');
      index.push({
        courseId: course.id,
        courseTitle: course.title,
        label: rec.title,
        kind: 'record',
        url: rec.url,
        text: clip(raw),
      });
    }
  }
  return index;
}

// Mirror the whole course folder into files/<id>/ so every relative link
// inside the lessons keeps working — lessons and reference HTML, the course
// assets, and the MISSION / RESOURCES / NOTES / learning-records files the
// lessons link to. Editor backups (*.bak) are left behind.
async function copyCourseFiles(course) {
  await copyDir(path.join(contentRoot, course.id), path.join(outDir, 'files', course.id));
}

async function writeShell() {
  let html = await fs.readFile(path.join(publicRoot, 'index.html'), 'utf8');
  // GitHub Pages serves sub-path sites with no `/` root, so absolute paths
  // are rewritten to relative ones and the static flag gets injected.
  const swaps = [
    ['href="/assets/styles.css"', 'href="assets/styles.css"'],
    ['href="/assets/favicon.svg"', 'href="assets/favicon.svg"'],
    ['href="/assets/apple-touch-icon.png"', 'href="assets/apple-touch-icon.png"'],
    ['href="/site.webmanifest"', 'href="site.webmanifest"'],
    [
      '<script type="module" src="/assets/app.js"></script>',
      '<script src="assets/config.js"></script>\n    <script type="module" src="assets/app.js"></script>',
    ],
  ];
  for (const [from, to] of swaps) {
    if (!html.includes(from)) throw new Error(`public/index.html 结构变了,找不到: ${from}`);
    html = html.replace(from, to);
  }
  await fs.writeFile(path.join(outDir, 'index.html'), html);

  for (const name of [
    'app.js',
    'styles.css',
    'favicon.svg',
    'apple-touch-icon.png',
    'icon-192.png',
    'icon-512.png',
  ]) {
    await copyFile(path.join(publicRoot, name), path.join(outDir, 'assets', name));
  }
  await fs.writeFile(path.join(outDir, 'assets', 'config.js'), 'window.__LC_STATIC__ = true;\n');
  // 放在站点根目录,manifest 里的 start_url "./" 才会指向站点根(而不是 assets/)。
  await copyFile(path.join(publicRoot, 'site.webmanifest'), path.join(outDir, 'site.webmanifest'));
  // Tell GitHub Pages to skip Jekyll, which would otherwise swallow files.
  await fs.writeFile(path.join(outDir, '.nojekyll'), '');
}

async function main() {
  if (!(await exists(contentRoot))) {
    console.error(`内容目录不存在: ${contentRoot}`);
    process.exit(1);
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const courses = await scanCourses(contentRoot);

  await writeShell();
  await writeJson(path.join(outDir, 'api', 'courses.json'), { courses: courses.map(courseSummary) });

  for (const course of courses) {
    const dir = path.join(contentRoot, course.id);
    await writeJson(
      path.join(outDir, 'api', 'courses', `${course.id}.json`),
      await buildCourseJson(dir, course),
    );
    await copyCourseFiles(course);
  }

  await writeJson(path.join(outDir, 'api', 'search-index.json'), await buildSearchIndex(courses));

  const lessons = courses.reduce((n, c) => n + c.counts.lessons, 0);
  console.log(`已导出 ${courses.length} 个主题 / ${lessons} 篇讲义 → ${path.relative(root, outDir)}`);
}

await main();
