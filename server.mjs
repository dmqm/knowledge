// Learning Center — a local, mobile-friendly portal that aggregates the
// `teach` workspaces living under the content root.
//
// Zero third-party dependencies: it runs on Node's built-in `http` server.
//
//   node server.mjs                 # listens on 127.0.0.1:4321
//   node server.mjs --host 0.0.0.0  # expose to your LAN
//   LC_PASSWORD=secret node server.mjs
//
// Config precedence: CLI flags > environment > config.json > defaults.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdown } from './lib/md.mjs';
import { scanCourses, readCourse, searchCourses, exists } from './lib/scan.mjs';
import { progressStore } from './lib/store.mjs';
import { makeAuth } from './lib/auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function loadConfig() {
  const defaults = { host: '127.0.0.1', port: 4321, password: '', contentRoot: './courses' };
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await fsp.readFile(path.join(__dirname, 'config.json'), 'utf8'));
  } catch {
    // no config file — fine
  }

  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    return undefined;
  };

  const cfg = {
    host: flag('host') ?? process.env.LC_HOST ?? fileConfig.host ?? defaults.host,
    port: Number(flag('port') ?? process.env.LC_PORT ?? fileConfig.port ?? defaults.port),
    password: flag('password') ?? process.env.LC_PASSWORD ?? fileConfig.password ?? defaults.password,
    contentRoot: path.resolve(
      __dirname,
      flag('content') ?? process.env.LC_CONTENT_ROOT ?? fileConfig.contentRoot ?? defaults.contentRoot,
    ),
    publicRoot: path.join(__dirname, 'public'),
    dataDir: path.join(__dirname, 'data'),
  };
  if (flag('no-password')) cfg.password = '';
  return cfg;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function sendFile(res, filePath, { cache = false } = {}) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Content-Length': stat.size,
      'Cache-Control': cache ? 'public, max-age=3600' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// Serve a file from `root`, refusing anything that escapes it.
async function serveStatic(res, root, rel, opts) {
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    res.writeHead(400);
    res.end('400 Bad Request');
    return;
  }
  const target = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  await sendFile(res, target, opts);
}

function loginPage() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>学习中心 · 登录</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
         font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;
         background:#0f1115; color:#e8eaed; }
  form { width:min(88vw,340px); display:grid; gap:14px; padding:28px;
         background:#171a20; border:1px solid #262b33; border-radius:16px; }
  h1 { margin:0 0 4px; font-size:20px; }
  p { margin:0; color:#9aa3b2; font-size:13px; }
  input,button { font:inherit; border-radius:10px; border:1px solid #2a303a; padding:12px 14px; }
  input { background:#0f1115; color:#e8eaed; }
  button { background:#3b82f6; color:#fff; border:0; font-weight:600; cursor:pointer; }
  .err { color:#f87171; font-size:13px; min-height:1em; }
</style>
</head>
<body>
  <form method="POST" action="/api/login">
    <h1>学习中心</h1>
    <p>请输入访问密码</p>
    <input type="password" name="password" autofocus autocomplete="current-password" placeholder="密码" />
    <div class="err" id="err"></div>
    <button type="submit">进入</button>
  </form>
  <script>
    document.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('err');
      err.textContent = '';
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: e.target.password.value }),
      });
      if (res.ok) location.href = '/';
      else err.textContent = '密码不正确';
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function courseSummary(course, progress) {
  const lessons = course.lessons;
  const map = (progress.courses[course.id] || {}).lessons || {};
  const done = lessons.filter((l) => map[l.file] && map[l.file].status === 'done').length;
  return {
    id: course.id,
    title: course.title,
    counts: course.counts,
    done,
    total: lessons.length,
    lastLesson: lessons.length ? lessons[lessons.length - 1].file : null,
    mtime: course.mtime,
  };
}

async function buildDetail(contentRoot, store, id) {
  const dir = path.join(contentRoot, id);
  if (!(await exists(dir))) return null;
  const course = await readCourse(dir, id);
  if (!course) return null;

  const [resourcesRaw, notesRaw, full] = await Promise.all([
    course.hasResources ? fsp.readFile(path.join(dir, 'RESOURCES.md'), 'utf8').catch(() => '') : '',
    course.hasNotes ? fsp.readFile(path.join(dir, 'NOTES.md'), 'utf8').catch(() => '') : '',
    store.get(),
  ]);

  const records = [];
  for (const rec of course.records) {
    const raw = await fsp
      .readFile(path.join(dir, 'learning-records', rec.file), 'utf8')
      .catch(() => '');
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
    progress: (full.courses[course.id] || {}).lessons || {},
  };
}

async function createCourse(contentRoot, name) {
  const { slugify } = await import('./lib/scan.mjs');
  const id = slugify(name);
  const dir = path.join(contentRoot, id);
  if (await exists(dir)) {
    return { error: `主题「${id}」已存在` };
  }
  await fsp.mkdir(path.join(dir, 'lessons'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'reference'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'learning-records'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'MISSION.md'),
    `# Mission: ${name}\n\n## Why\n（为什么想学这个？它会怎样改变你的工作或生活？）\n\n## Success looks like\n- \n\n## Constraints\n- \n\n## Out of scope\n- \n`,
  );
  await fsp.writeFile(
    path.join(dir, 'RESOURCES.md'),
    `# ${name} Resources\n\n## Knowledge\n\n- \n\n## Wisdom (Communities)\n\n- \n`,
  );
  await fsp.writeFile(path.join(dir, 'NOTES.md'), `# Notes\n\n`);

  // Make the workspace usable by the `teach` skill out of the box.
  await fsp.writeFile(
    path.join(dir, 'TEACH.md'),
    `这个目录是一个 \`teach\` 教学 workspace。\n\n要继续学习，请在 OpenCode 中把工作目录切换到这里，然后运行 \`teach\` 技能。\n`,
  );
  return { id };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const config = await loadConfig();
await fsp.mkdir(config.contentRoot, { recursive: true });
await fsp.mkdir(config.dataDir, { recursive: true });

const store = progressStore(path.join(config.dataDir, 'progress.json'));
const auth = await makeAuth({ password: config.password, secretFile: path.join(config.dataDir, 'secret') });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    // --- auth gate -------------------------------------------------------
    const cookies = parseCookies(req);
    const authed = !auth.required || auth.verifyCookie(cookies.lc_session);

    if (auth.required && !authed) {
      if (pathname === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loginPage());
        return;
      }
      if (pathname === '/api/login' && req.method === 'POST') {
        const body = await readBody(req);
        let password = '';
        try {
          password = JSON.parse(body).password;
        } catch {
          password = '';
        }
        if (auth.checkPassword(password)) {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': `lc_session=${auth.issue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
              30 * 24 * 3600
            }`,
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          sendJson(res, 401, { ok: false, error: '密码不正确' });
        }
        return;
      }
      if (pathname.startsWith('/api/')) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }

    // --- api -------------------------------------------------------------
    if (pathname === '/api/state') {
      sendJson(res, 200, { authRequired: !!auth.required, authed: true, contentRoot: config.contentRoot });
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      res.writeHead(200, {
        'Set-Cookie': 'lc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === '/api/courses' && req.method === 'GET') {
      const [courses, full] = await Promise.all([scanCourses(config.contentRoot), store.get()]);
      sendJson(res, 200, { courses: courses.map((c) => courseSummary(c, full)) });
      return;
    }

    if (pathname === '/api/courses' && req.method === 'POST') {
      const body = await readBody(req);
      let name = '';
      try {
        name = String(JSON.parse(body).name || '').trim();
      } catch {
        name = '';
      }
      if (!name) {
        sendJson(res, 400, { error: '请填写主题名称' });
        return;
      }
      const result = await createCourse(config.contentRoot, name);
      if (result.error) {
        sendJson(res, 409, { error: result.error });
        return;
      }
      sendJson(res, 200, { ok: true, id: result.id });
      return;
    }

    const courseMatch = pathname.match(/^\/api\/courses\/([^/]+)$/);
    if (courseMatch) {
      const id = decodeURIComponent(courseMatch[1]);
      if (req.method === 'GET') {
        const detail = await buildDetail(config.contentRoot, store, id);
        if (!detail) {
          sendJson(res, 404, { error: '未找到该主题' });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }
      if (req.method === 'DELETE') {
        const from = path.join(config.contentRoot, id);
        if (!(await exists(from))) {
          sendJson(res, 404, { error: '未找到该主题' });
          return;
        }
        const trash = path.join(config.contentRoot, '.trash');
        await fsp.mkdir(trash, { recursive: true });
        const to = path.join(trash, `${id}-${Date.now()}`);
        await fsp.rename(from, to);
        sendJson(res, 200, { ok: true, movedTo: path.relative(config.contentRoot, to) });
        return;
      }
    }

    if (pathname === '/api/progress' && req.method === 'POST') {
      const body = await readBody(req);
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        payload = {};
      }
      const { course, file, status } = payload;
      if (!course || !file || !['done', 'none'].includes(status)) {
        sendJson(res, 400, { error: '参数不完整' });
        return;
      }
      const data = await store.setLesson(course, file, status);
      sendJson(res, 200, { ok: true, lessons: (data.courses[course] || {}).lessons || {} });
      return;
    }

    if (pathname === '/api/search') {
      const results = await searchCourses(config.contentRoot, url.searchParams.get('q'));
      sendJson(res, 200, { results });
      return;
    }

    // --- static ----------------------------------------------------------
    if (pathname.startsWith('/files/')) {
      await serveStatic(res, config.contentRoot, pathname.slice('/files/'.length));
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      await sendFile(res, path.join(config.publicRoot, 'index.html'));
      return;
    }

    if (pathname === '/favicon.ico') {
      await sendFile(res, path.join(config.publicRoot, 'favicon.svg'));
      return;
    }

    if (pathname === '/site.webmanifest') {
      await sendFile(res, path.join(config.publicRoot, 'site.webmanifest'), { cache: true });
      return;
    }

    if (pathname.startsWith('/assets/')) {
      // no-cache: the portal is edited locally, so a phone on the LAN must not
      // keep a stale app.js/styles.css for an hour.
      await serveStatic(res, config.publicRoot, pathname.slice('/assets/'.length));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' || config.host === '::' ? '<your-LAN-IP>' : config.host;
  const lines = [
    '',
    '  学习中心 Learning Center 已启动',
    '',
    `  本机访问:  http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`,
    `  局域网:    http://${shown}:${config.port}`,
    `  内容目录:  ${config.contentRoot}`,
    `  密码保护:  ${config.password ? '已开启' : '未开启'}`,
    '',
  ];
  console.log(lines.join('\n'));
});
