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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { renderMarkdown } from '../lib/md.mjs';
import { scanCourses, exists } from '../lib/scan.mjs';
import { isSameOrInside, realPath } from '../lib/safe-path.mjs';

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

// Paths the build must never touch, no matter what `--out` says. `main()`
// deletes the output directory before writing, so an out dir that *contains*
// any of these (or lives inside them) would destroy sources or local state.
const PROTECTED = [
  root,
  publicRoot,
  contentRoot,
  path.join(root, 'courses'),
  path.join(root, 'lib'),
  path.join(root, 'scripts'),
  path.join(root, 'data'),
  path.join(root, 'docs'),
  path.join(root, '.git'),
  path.join(root, '.github'),
];

// Returns a human-readable reason when `out` is unsafe to wipe, else null.
// Both sides are resolved to their real locations first, so `--out symlink`
// and `..` spellings cannot bypass the check.
function unsafeOutputReason(out) {
  const target = realPath(out);
  for (const candidate of PROTECTED) {
    const protectedReal = realPath(candidate);
    // The out dir is, or contains, something we must keep (root, courses, ...).
    if (isSameOrInside(target, protectedReal)) {
      return `输出目录会删除受保护路径: ${candidate}`;
    }
    // The out dir lives inside a source/live directory. `dist/` under the repo
    // root is fine; `public/x` or `courses/x` is not.
    if (candidate !== root && isSameOrInside(protectedReal, target)) {
      return `输出目录位于受保护路径内: ${candidate}`;
    }
  }
  return null;
}

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

// Fail the build instead of publishing an empty/partial site: every file the
// scan listed must be readable while exporting.
async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`无法读取文件 ${file}: ${err.message}`);
  }
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
// `_originals` holds the untouched source images (full-resolution masters kept
// for provenance); only the optimized derivatives belong on the published site.
function isPublishable(name) {
  return !name.startsWith('.') && !name.endsWith('.bak') && name !== '_originals';
}

async function copyDir(src, dest) {
  let entries;
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch (err) {
    throw new Error(`无法读取目录 ${src}: ${err.message}`);
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
    course.hasResources ? readText(path.join(dir, 'RESOURCES.md')) : '',
    course.hasNotes ? readText(path.join(dir, 'NOTES.md')) : '',
  ]);

  const records = [];
  for (const rec of course.records) {
    const raw = await readText(path.join(dir, 'learning-records', rec.file));
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
      text: course.mission.replace(/[#*`>]/g, ''),
    });

    for (const lesson of course.lessons) {
      const raw = await readText(path.join(dir, 'lessons', lesson.file));
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
      const raw = await readText(path.join(dir, 'learning-records', rec.file));
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

// Mirror the whole course folder into files/<id>/ so every relative link
// inside the lessons keeps working — lessons and reference HTML, the course
// assets, and the MISSION / RESOURCES / NOTES / learning-records files the
// lessons link to. Editor backups (*.bak) are left behind.
async function copyCourseFiles(course) {
  await copyDir(path.join(contentRoot, course.id), path.join(outDir, 'files', course.id));
}

// Independent filesystem count of what the source tree actually holds. Used
// after the build to prove the export did not silently drop content: a stale
// cache or a half-read scan would otherwise publish "0 个主题" with exit 0.
async function countSource(rootDir) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`无法读取内容目录 ${rootDir}: ${err.message}`);
  }
  let topics = 0;
  let lessons = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(rootDir, entry.name);
    const lessonsDir = path.join(dir, 'lessons');
    const hasMission = await exists(path.join(dir, 'MISSION.md'));
    const hasLessons = await exists(lessonsDir);
    if (!hasMission && !hasLessons) continue;
    topics += 1;
    if (!hasLessons) continue;
    let names;
    try {
      names = await fs.readdir(lessonsDir);
    } catch (err) {
      throw new Error(`无法读取目录 ${lessonsDir}: ${err.message}`);
    }
    lessons += names.filter((n) => n.toLowerCase().endsWith('.html')).length;
  }
  return { topics, lessons };
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

  // GitHub Pages caches /assets/ for a while. Stamp the CSS/JS with a content
  // hash so a fresh deploy is picked up on the next page load, not "in 10 min".
  const stamp = createHash('sha1')
    .update(await fs.readFile(path.join(publicRoot, 'styles.css')))
    .update(await fs.readFile(path.join(publicRoot, 'app.js')))
    .update(await fs.readFile(path.join(publicRoot, 'route-logic.js')))
    .digest('hex')
    .slice(0, 8);
  html = html
    .replace('assets/styles.css', `assets/styles.css?v=${stamp}`)
    .replace('assets/app.js', `assets/app.js?v=${stamp}`);
  await fs.writeFile(path.join(outDir, 'index.html'), html);

  for (const name of [
    'app.js',
    'route-logic.js',
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
  const unsafe = unsafeOutputReason(outDir);
  if (unsafe) {
    console.error(`拒绝导出：${unsafe}\n  --out ${outDir}`);
    process.exit(1);
  }
  if (await exists(outDir)) {
    const stat = await fs.stat(outDir).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      console.error(`拒绝导出：输出路径已存在且不是目录: ${outDir}`);
      process.exit(1);
    }
  }

  if (!(await exists(contentRoot))) {
    console.error(`内容目录不存在: ${contentRoot}`);
    process.exit(1);
  }
  const contentStat = await fs.stat(contentRoot).catch(() => null);
  if (!contentStat || !contentStat.isDirectory()) {
    console.error(`内容根不是目录: ${contentRoot}`);
    process.exit(1);
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const courses = await scanCourses(contentRoot, { strict: true });

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

  // The build already read every file strictly; cross-check the totals against
  // an independent walk of the source so a partial/empty export can never be
  // reported as a success.
  const source = await countSource(contentRoot);
  if (source.topics !== courses.length || source.lessons !== lessons) {
    console.error(
      `导出校验失败：主题 ${courses.length}（源 ${source.topics}） / 讲义 ${lessons}（源 ${source.lessons}）`,
    );
    process.exit(1);
  }

  console.log(`已导出 ${courses.length} 个主题 / ${lessons} 篇讲义 → ${path.relative(root, outDir)}`);
}

try {
  await main();
} catch (err) {
  console.error(`导出失败：${err.message}`);
  process.exit(1);
}
