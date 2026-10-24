// Learning Center front-end. A small hash-routed single-page app, no deps.
//
// It runs in two modes, picked by `window.__LC_STATIC__` (set by the generated
// `assets/config.js` in a static export):
//   - server mode (default): talks to server.mjs's JSON API — full read/write.
//   - static mode: reads pre-built JSON under `api/`, keeps progress in
//     localStorage, and hides the write actions. Used for the GitHub Pages
//     build, which is read-only.

const STATIC = typeof window !== 'undefined' && window.__LC_STATIC__ === true;
const PROGRESS_KEY = 'lc:progress';
// Last-read position per course, for the "继续阅读" strip (both modes).
const LASTREAD_KEY = 'lc:last-read';
// Reader font scale (zoom applied to the lesson document).
const FONTSCALE_KEY = 'lc:font-scale';
const FONT_STEPS = [1, 1.15, 1.3, 0.85];

const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
const toastEl = document.getElementById('toast');

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

const state = { courses: [], course: null, progress: {} };

// A chevron for the reader's circular nav buttons. Inline SVG instead of a
// text arrow: the glyph stays crisp at any size and inherits the button's
// colour, so it follows the theme without extra rules.
const chevron = (dir) =>
  `<svg class="chev chev-${dir}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
  `<path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2.2" ` +
  `stroke-linecap="round" stroke-linejoin="round"/></svg>`;


// Home category filter (null = 全部). Reset every time the home page is opened.
let homeFilter = null;

// Arrow-key handler for the reader; swapped on every render so it can't pile up.
let readerKeys = null;

// ------------------------------------------------------------ data source ----
// Every read/write the app needs goes through these, so the two modes stay
// honest and the rendering code below never has to know which one is active.

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function fetchJson(path) {
  // Static builds are republished on every push; GitHub Pages caches JSON for
  // several minutes, so always bypass the HTTP cache to pick up new courses.
  const res = await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- progress (browser-local in static mode) ---------------------------------

function readLocalProgress() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null');
    if (parsed && typeof parsed === 'object' && parsed.courses) return parsed;
  } catch {
    // corrupt / unavailable — start fresh
  }
  return { courses: {} };
}

function localLessons(courseId) {
  return (readLocalProgress().courses[courseId] || {}).lessons || {};
}

function writeLocalLesson(courseId, file, status) {
  const all = readLocalProgress();
  const course = all.courses[courseId] || (all.courses[courseId] = { lessons: {} });
  if (!course.lessons) course.lessons = {};
  if (status === 'none') delete course.lessons[file];
  else course.lessons[file] = { status, updatedAt: Date.now() };
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    // storage full / disabled — progress simply won't persist
  }
  return course.lessons;
}

// --- last-read (feeds the 继续阅读 strip; browser-local in both modes) -------

// The reader registers itself here so the final scroll position can be forced
// to disk on the way out (hash change / pagehide) instead of being dropped by
// the throttle.
let activeReader = null;

function flushActiveReaderY() {
  if (!activeReader) return;
  try {
    const w = document.getElementById('r-frame').contentWindow;
    const y = w.scrollY || 0;
    saveLastRead({ ...activeReader, y, at: Date.now() });
  } catch {
    // frame gone cross-origin — nothing to save
  }
}

function readLastRead() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LASTREAD_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function lastReadRecord(courseId) {
  const r = readLastRead()[courseId];
  return r && r.kind === 'lessons' && r.file ? r : null;
}

function saveLastRead(rec) {
  if (!rec || !rec.id || !rec.file) return;
  const all = readLastRead();
  all[rec.id] = { ...rec, kind: 'lessons' };
  try {
    localStorage.setItem(LASTREAD_KEY, JSON.stringify(all));
  } catch {
    // storage disabled — resume simply won't persist
  }
}

// A course card (server summaries lack `lessons`, and the static home list
// stores lesson file names as plain strings — accept either shape; only
// validate the file against a real object entry when one is available).
function resumeTarget(courses) {
  const all = readLastRead();
  let best = null;
  for (const c of courses) {
    const r = all[c.id];
    if (!r || r.kind !== 'lessons' || !r.file) continue;
    if (Array.isArray(c.lessons)) {
      const hit = c.lessons.some((l) => (typeof l === 'string' ? l === r.file : l.file === r.file));
      if (!hit) continue;
    }
    if (!best || (r.at || 0) > (best.r.at || 0)) best = { c, r };
  }
  return best;
}

// Route to the reader while stashing the exact scroll position, so the lesson
// opens where it was left — same mechanism the theme reload uses.
function stashRestoreAndGo(courseId, file, y) {
  try {
    sessionStorage.setItem(
      READER_RESTORE_KEY,
      JSON.stringify({ href: new URL(fileUrl(courseId, 'lessons', file), location.href).href, y: Number(y) || 0, at: Date.now() }),
    );
  } catch {
    // stash is best-effort; the lesson still opens at the top
  }
  go(`#/read/${encodeURIComponent(courseId)}/lessons/${encodeURIComponent(file)}`);
}

// --- courses -----------------------------------------------------------------

async function listCourses() {
  if (STATIC) {
    const { courses = [] } = await fetchJson('api/courses.json');
    for (const c of courses) {
      const files = c.lessons || [];
      const done = localLessons(c.id);
      c.total = files.length;
      c.done = files.filter((f) => done[f] && done[f].status === 'done').length;
    }
    return courses;
  }
  const { courses } = await api('/api/courses');
  return courses;
}

async function loadCourse(id) {
  if (STATIC) {
    const { course } = await fetchJson(`api/courses/${encodeURIComponent(id)}.json`);
    return { course, progress: localLessons(id) };
  }
  const { course, progress } = await api(`/api/courses/${encodeURIComponent(id)}`);
  return { course, progress: progress || {} };
}

async function setProgress(courseId, file, status) {
  if (STATIC) {
    writeLocalLesson(courseId, file, status);
    return;
  }
  await api('/api/progress', {
    method: 'POST',
    body: JSON.stringify({ course: courseId, file, status }),
  });
}

// --- search ------------------------------------------------------------------

let searchIndexPromise = null;

function searchIndex() {
  if (!searchIndexPromise) searchIndexPromise = fetchJson('api/search-index.json');
  return searchIndexPromise;
}

function searchLocally(index, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const results = [];
  for (const doc of index) {
    const text = doc.text || '';
    const idx = text.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 60);
    const snippet = `${idx > 60 ? '…' : ''}${text.slice(start, idx + needle.length + 90)}${
      idx + needle.length + 90 < text.length ? '…' : ''
    }`;
    results.push({
      courseId: doc.courseId,
      courseTitle: doc.courseTitle,
      label: doc.label,
      kind: doc.kind,
      url: doc.url,
      snippet: snippet.trim(),
      score: localRelevance(doc, needle),
    });
  }
  // Same ranking as the server: title beats body, more mentions beat one,
  // an early mention beats a late one.
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 60);
}

function localRelevance(doc, q) {
  const label = String(doc.label || '').toLowerCase();
  const courseTitle = String(doc.courseTitle || '').toLowerCase();
  const lower = String(doc.text || '').toLowerCase();
  let score = 0;
  if (label.includes(q)) score += 60;
  if (courseTitle.includes(q)) score += 30;
  if (label.trim() === q) score += 40;
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

async function searchCourses(q) {
  if (STATIC) return searchLocally(await searchIndex(), q);
  const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
  return results;
}

// Live search: results render in-place below the input, so typing never loses
// focus (the old flow navigated away mid-sentence). Enter still jumps to the
// full search page for a deep-linkable URL.
let searchSeq = 0;

function resultRows(results, limit = results.length) {
  const shown = results.slice(0, limit);
  return `<div class="rows">${shown
    .map((r) => {
      const open =
        r.kind === 'lesson'
          ? `#/read/${encodeURIComponent(r.courseId)}/lessons/${encodeURIComponent(r.url.split('/').pop())}`
          : `#/c/${encodeURIComponent(r.courseId)}`;
      return `
    <a class="row" href="${open}">
      <span class="idx">${r.kind === 'lesson' ? '▤' : r.kind === 'record' ? '✎' : '◎'}</span>
      <div class="body">
        <div class="t">${esc(r.label)}</div>
        <div class="s">${esc(r.courseTitle)} · ${esc(r.snippet)}</div>
      </div>
    </a>`;
    })
    .join('')}</div>`;
}

async function liveSearch(query, box) {
  const token = ++searchSeq;
  const needle = String(query || '').trim();
  if (!needle) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = '<div class="spinner">搜索中…</div>';
  try {
    const results = await searchCourses(needle);
    if (token !== searchSeq || !box.isConnected) return;
    box.innerHTML = results.length
      ? `<div class="section-title">「${esc(needle)}」· ${results.length} 条结果</div>${resultRows(results, 12)}`
      : emptyPanel(`没有找到「${needle}」。`);
  } catch (err) {
    if (token === searchSeq && box.isConnected) {
      box.innerHTML = `<div class="empty"><div class="big">⚠︎</div>${esc(err.message)}</div>`;
    }
  }
}

function wireLiveSearch(input, box, debounceMs = 280) {
  input.addEventListener('input', () => {
    const value = input.value;
    clearTimeout(input._lcSearch);
    input._lcSearch = setTimeout(() => liveSearch(value, box), debounceMs);
  });
}

// --- file URLs ---------------------------------------------------------------

function fileUrl(id, kind, file) {
  const base = STATIC ? 'files' : '/files';
  return `${base}/${encodeURIComponent(id)}/${kind}/${encodeURIComponent(file)}`;
}

// ---------------------------------------------------------------- chrome ----

// Stable pseudo-random hue per course id — drives the tile/hero accent color.
function courseHue(s) {
  return [...String(s)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2200);
}

function setTopbar(html) {
  topbar.innerHTML = html || '';
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// ------------------------------------------------------------------ theme ----
// The reader can force a day or night palette at any time. The choice lives in
// localStorage and is written as `data-theme` on <html>; the CSS (portal and
// every course stylesheet) answers to that attribute. Without a saved choice we
// simply follow the system setting, including live changes.

const THEME_KEY = 'lc:theme';
const THEME_COLOR = { dark: '#14130f', light: '#f7f4ec' };
const READER_RESTORE_KEY = 'lc:reader-restore';
const SCROLL_RESTORE_KEY = 'lc:scroll-restore';
const RESTORE_TTL = 120000;

const SUN_ICON = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.1"/><path d="M12 2.7v2.1M12 19.2v2.1M4.4 4.4l1.5 1.5M18.1 18.1l1.5 1.5M2.7 12h2.1M19.2 12h2.1M4.4 19.6l1.5-1.5M18.1 5.9l1.5-1.5"/></svg>`;
const MOON_ICON = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.4 14.2A8.6 8.6 0 0 1 9.8 3.6a8.6 8.6 0 1 0 10.6 10.6Z"/></svg>`;

function systemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

function savedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : savedTheme() || systemTheme();
}

// The button advertises the mode you'd switch *to*, which is what people expect
// from a sun/moon toggle: tap the sun to get daylight.
function nextTheme() {
  return currentTheme() === 'dark' ? 'light' : 'dark';
}

function themeButtonHTML() {
  const target = nextTheme();
  const label = target === 'light' ? '切换到白天模式' : '切换到夜间模式';
  return `<button class="iconbtn theme-toggle" data-theme-toggle title="${label}" aria-label="${label}">${
    target === 'light' ? SUN_ICON : MOON_ICON
  }</button>`;
}

function syncThemeButtons() {
  const target = nextTheme();
  const label = target === 'light' ? '切换到白天模式' : '切换到夜间模式';
  const icon = target === 'light' ? SUN_ICON : MOON_ICON;
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.innerHTML = icon;
    btn.title = label;
    btn.setAttribute('aria-label', label);
  });
}

// The lesson itself is an iframe (same origin, in both server and static
// modes), so push the theme into that document as well.
function syncReaderTheme() {
  const frame = document.getElementById('r-frame');
  if (!frame) return;
  let doc;
  try {
    doc = frame.contentDocument;
  } catch {
    return; // navigated somewhere cross-origin — nothing we can style
  }
  if (!doc || !doc.documentElement) return;
  const theme = currentTheme();
  doc.documentElement.dataset.theme = theme;
  doc.documentElement.style.colorScheme = theme;
}

// Some mobile browsers only re-read these hints when the tag itself is
// replaced, so swap the element instead of just editing `content`.
function setMetaContent(name, content) {
  const old = document.querySelector(`meta[name="${name}"]`);
  if (old && old.getAttribute('content') === content) return;
  const meta = document.createElement('meta');
  meta.name = name;
  meta.content = content;
  if (old) old.replaceWith(meta);
  else document.head.appendChild(meta);
}

// A home-screen web app on iOS fixes the system status bar style when the
// document loads; editing the meta afterwards does not repaint it. Only that
// specific case needs a reload — and only for a real user choice, never for the
// system-following path on boot.
function isIOSStandalone() {
  const iOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return (
    iOS &&
    (navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches))
  );
}

// iOS 26 (Safari 26) stopped honouring theme-color: the status bar now follows
// the page background, so a theme change can repaint both at once. Older
// versions still need the reload to re-read the status-bar hint on load.
function iosNeedsStatusBarReload() {
  if (!isIOSStandalone()) return false;
  const match = (navigator.userAgent || '').match(/\bOS (\d+)[._]/);
  const major = match ? Number(match[1]) : 0;
  return major === 0 || major < 26;
}

function saveReaderRestore() {
  const frame = document.getElementById('r-frame');
  if (!frame) return false;
  try {
    const win = frame.contentWindow;
    const href = win.location.href;
    if (new URL(href).origin !== location.origin) return false;
    const doc = win.document;
    const y = win.scrollY || doc.documentElement.scrollTop || doc.body.scrollTop || 0;
    sessionStorage.setItem(READER_RESTORE_KEY, JSON.stringify({ href, y, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

function saveScrollRestore() {
  try {
    sessionStorage.setItem(
      SCROLL_RESTORE_KEY,
      JSON.stringify({ hash: location.hash || '#/', y: window.scrollY, at: Date.now() }),
    );
  } catch {
    // storage disabled — the theme still persists for this visit
  }
}

function takeReaderRestore(id, kind) {
  try {
    const raw = sessionStorage.getItem(READER_RESTORE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(READER_RESTORE_KEY);
    const r = JSON.parse(raw);
    if (!r || Date.now() - r.at > RESTORE_TTL) return null;
    const u = new URL(r.href);
    if (u.origin !== location.origin) return null;
    // The iframe may have followed in-lesson links; accept only this course and
    // this kind, so a stale entry can never pull in an unrelated page.
    if (!u.pathname.includes(`/files/${encodeURIComponent(id)}/${kind}/`)) return null;
    return { href: u.href, y: Number(r.y) || 0 };
  } catch {
    return null;
  }
}

function takeScrollRestore() {
  try {
    const raw = sessionStorage.getItem(SCROLL_RESTORE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(SCROLL_RESTORE_KEY);
    const r = JSON.parse(raw);
    if (!r || Date.now() - r.at > RESTORE_TTL) return null;
    if (r.hash !== (location.hash || '#/')) return null;
    return Number(r.y) || 0;
  } catch {
    return null;
  }
}

function applyTheme(theme, persist = true) {
  // Safari 26 samples this fixed 4px strip for the status bar tint. Paint it
  // before the rest of the theme so the system sees the new surface at once.
  const statusTint = document.getElementById('lc-status-tint');
  if (statusTint) {
    statusTint.style.backgroundColor = THEME_COLOR[theme];
    void statusTint.offsetHeight;
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  let stored = false;
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
      stored = true;
    } catch {
      // storage disabled — the switch still works for this visit
    }
  }
  // Phone status bar / browser chrome: tint it to the reading surface, and let
  // the iOS status bar text invert too when the site runs as a home-screen app.
  setMetaContent('theme-color', THEME_COLOR[theme]);
  setMetaContent(
    'apple-mobile-web-app-status-bar-style',
    theme === 'dark' ? 'black-translucent' : 'default',
  );

  if (stored && iosNeedsStatusBarReload()) {
    // Park where the reader was, then reload so iOS re-reads the status bar
    // style from the pre-paint script. The hash already restores the route.
    if (!saveReaderRestore()) saveScrollRestore();
    location.reload();
    return;
  }

  syncThemeButtons();
  syncReaderTheme();
}

// One delegated handler survives every re-render of the topbar / reader bar.
document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('[data-theme-toggle]') : null;
  if (!btn) return;
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
});

if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const follow = () => {
    if (!savedTheme()) applyTheme(systemTheme(), false);
  };
  if (mq.addEventListener) mq.addEventListener('change', follow);
  else if (mq.addListener) mq.addListener(follow);
}

// --------------------------------------------------------------- routing ----

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  return { path: pathPart || '/', params: new URLSearchParams(queryPart || '') };
}

async function render() {
  flushActiveReaderY(); // reader about to unmount — save the exact position
  document.body.classList.remove('reader-open');
  if (readerKeys) {
    document.removeEventListener('keydown', readerKeys);
    readerKeys = null;
  }
  const { path, params } = parseHash();
  let m;
  if ((m = path.match(/^\/c\/(.+)$/))) return renderCourse(decodeURIComponent(m[1]));
  if ((m = path.match(/^\/read\/([^/]+)\/([^/]+)\/(.+)$/)))
    return renderReader(decodeURIComponent(m[1]), m[2], decodeURIComponent(m[3]));
  if (path === '/search') return renderSearch(params.get('q') || '');
  return renderHome();
}

// ------------------------------------------------------------------ home ----

async function renderHome() {
  setTopbar(`
    <div class="brand"><span class="dot"></span>学习中心</div>
    <div class="spacer"></div>
    ${themeButtonHTML()}
    <button class="iconbtn" id="btn-refresh" title="刷新">↻</button>
  `);
  app.innerHTML = '<div class="spinner">加载中…</div>';

  document.getElementById('btn-refresh').onclick = () => {
    loadHome(true);
  };

  app.innerHTML = `
    <div class="search">
      <span class="glass">⌕</span>
      <input id="q" placeholder="搜索课程、讲义、学习记录…" enterkeyhint="search" />
    </div>
    <div id="resume"></div>
    <div class="chips" id="catbar" hidden></div>
    <div id="courselist"></div>
    <div id="liveres" hidden></div>
  `;
  homeFilter = null;

  const q = document.getElementById('q');
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && q.value.trim()) go(`#/search?q=${encodeURIComponent(q.value.trim())}`);
  });
  wireLiveSearch(q, document.getElementById('liveres'));

  await loadHome();
}

async function loadHome(refresh = false) {
  const list = document.getElementById('courselist');
  if (!list) return;
  if (refresh) list.innerHTML = '<div class="spinner">刷新中…</div>';
  try {
    const courses = await listCourses();
    state.courses = courses;
    paintHome(courses);
    paintResume(courses);
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="big">⚠︎</div>${esc(err.message)}</div>`;
  }
}

// The first slot on home belongs to the highest-frequency action: picking up
// the last lesson you were reading (exact scroll position included).
function paintResume(courses) {
  const box = document.getElementById('resume');
  if (!box) return;
  const found = resumeTarget(courses);
  if (!found) {
    box.innerHTML = '';
    return;
  }
  const { c, r } = found;
  const title = lessonTitle(r.title) || r.file;
  box.innerHTML = `
    <a class="resume" href="#/read/${encodeURIComponent(c.id)}/lessons/${encodeURIComponent(r.file)}"
       title="${esc(title)}">
      <span class="rtag">继续</span>
      <div class="rt">${esc(c.title)} · <b>${esc(title)}</b></div>
      <span class="rarrow">›</span>
    </a>`;
  box.querySelector('.resume').addEventListener('click', (e) => {
    e.preventDefault();
    stashRestoreAndGo(c.id, r.file, r.y);
  });
}

// One flat, full-width grid plus a category chip row. Sections would cap each
// group at its own course count and leave most of a wide screen empty, so the
// group is a filter here instead — classification without losing density.
function paintHome(courses) {
  const list = document.getElementById('courselist');
  if (!list) return;
  const groups = [];
  const counts = new Map();
  for (const c of courses) {
    const name = c.group || '更多主题';
    if (!counts.has(name)) groups.push(name);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if (homeFilter && !groups.includes(homeFilter)) homeFilter = null;

  const bar = document.getElementById('catbar');
  if (bar) {
    if (groups.length < 2) {
      bar.hidden = true;
      bar.innerHTML = '';
    } else {
      bar.hidden = false;
      const chip = (value, label, n) =>
        `<button class="chip ${(homeFilter || '') === value ? 'active' : ''}" data-cat="${esc(value)}">${esc(label)}<span>${n}</span></button>`;
      bar.innerHTML =
        chip('', '全部', courses.length) +
        groups.map((g) => chip(g, g, counts.get(g) || 0)).join('');
      bar.querySelectorAll('[data-cat]').forEach((btn) => {
        btn.onclick = () => {
          homeFilter = btn.dataset.cat || null;
          paintHome(courses);
        };
      });
    }
  }

  const shown = homeFilter
    ? courses.filter((c) => (c.group || '更多主题') === homeFilter)
    : courses;
  list.innerHTML = shown.length
    ? `<div class="cards">${shown.map(courseCard).join('')}</div>`
    : emptyState();
}

function courseCard(c) {
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const complete = c.total > 0 && c.done === c.total;
  const size = c.counts.lessons ? `${c.counts.lessons} 讲` : '尚无内容';
  return `
    <a class="card" style="--hue:${courseHue(c.id)}" title="${esc(c.title)}" href="#/c/${encodeURIComponent(c.id)}">
      <span class="tile">${esc(c.title.trim().charAt(0) || '?')}</span>
      <div class="tile-txt">
        <h3>${esc(c.title)}</h3>
        <div class="meta">
          ${c.total ? `<span class="stat ${complete ? 'good' : ''}">${c.done}/${c.total}</span><span>·</span>` : ''}
          <span>${size}</span>
        </div>
      </div>
      ${c.total ? `<span class="bar"><span style="width:${pct}%"></span></span>` : ''}
    </a>`;
}

function emptyState() {
  return `
    <div class="empty">
      <div class="big">📚</div>
      <p>还没有学习主题。</p>
      <p class="small faint">用 <code>teach</code> 在某个课程目录里生成的内容会自动出现在这里。</p>
    </div>`;
}

// ---------------------------------------------------------------- course ----

async function renderCourse(id) {
  setTopbar(`
    <button class="back" id="btn-back">‹ 返回</button>
    <div class="spacer"></div>
    ${themeButtonHTML()}
    ${STATIC ? '' : '<button class="iconbtn" id="btn-more" title="更多">⋯</button>'}
  `);
  document.getElementById('btn-back').onclick = () => go('#/');
  app.innerHTML = '<div class="spinner">加载中…</div>';

  let detail;
  try {
    detail = await loadCourse(id);
  } catch (err) {
    setTopbar(`<button class="back" id="btn-back">‹ 返回</button>`);
    document.getElementById('btn-back').onclick = () => go('#/');
    app.innerHTML = `<div class="empty"><div class="big">⚠︎</div>${esc(err.message)}</div>`;
    return;
  }

  state.course = detail.course;
  state.progress = detail.progress || {};
  const c = detail.course;

  if (!STATIC) {
    document.getElementById('btn-more').onclick = () => {
      if (confirm(`删除主题「${c.title}」？\n（会移动到 courses/.trash，可恢复）`)) {
        api(`/api/courses/${encodeURIComponent(c.id)}`, { method: 'DELETE' })
          .then(() => {
            toast('已移入回收站');
            go('#/');
          })
          .catch((e) => toast(e.message));
      }
    };
  }

  const done = c.lessons.filter((l) => (state.progress[l.file] || {}).status === 'done').length;
  const lr = lastReadRecord(c.id);
  const resumeIdx = lr ? c.lessons.findIndex((l) => l.file === lr.file) : -1;
  const tabs = [
    ['lessons', `课程 ${c.counts.lessons}`],
    ['reference', `参考 ${c.counts.reference}`],
    ['records', `学习记录 ${c.counts.records}`],
  ];
  if (c.hasResources) tabs.push(['resources', '资源']);
  if (c.hasNotes) tabs.push(['notes', '备注']);

  app.innerHTML = `
    <div class="hero" style="--hue:${courseHue(c.id)}">
      <h1>${esc(c.title)}</h1>
      <div class="meta">
        <span class="pill ${done === c.counts.lessons && c.counts.lessons ? 'good' : ''}">${done}/${c.counts.lessons} 已完成</span>
        <button class="linkbtn" id="btn-toggle-mission">查看使命</button>
        ${resumeIdx >= 0 ? `<button class="linkbtn" id="btn-resume">上次读到 · ${esc(lessonTitle(lr.title) || `第 ${resumeIdx + 1} 讲`)}</button>` : ''}
        <span class="dirpath">courses/${esc(c.id)}</span>
      </div>
      ${c.counts.lessons ? `<div class="bar"><span style="width:${c.counts.lessons ? Math.round((done / c.counts.lessons) * 100) : 0}%"></span></div>` : ''}
    </div>
    <div id="mission" class="prose" hidden style="margin-top:14px">${c.missionHtml || '<p class="faint">尚未填写 MISSION.md</p>'}</div>
    <div class="tabs" id="tabs">
      ${tabs.map(([k, label], i) => `<button data-tab="${k}" class="${i === 0 ? 'active' : ''}">${esc(label)}</button>`).join('')}
    </div>
    <div id="tabpanel"></div>
  `;

  document.getElementById('btn-toggle-mission').onclick = () => {
    const m = document.getElementById('mission');
    m.hidden = !m.hidden;
  };

  if (resumeIdx >= 0) {
    const btn = document.getElementById('btn-resume');
    btn.onclick = () => stashRestoreAndGo(c.id, lr.file, lr.y);
  }

  const panel = document.getElementById('tabpanel');
  const renderTab = (key) => {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    // Long tab bars overflow on a phone — keep the active tab visible.
    document.querySelector('#tabs button.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    if (key === 'lessons') panel.innerHTML = lessonRows(c.lessons);
    else if (key === 'reference') panel.innerHTML = docRows(c.reference);
    else if (key === 'records')
      panel.innerHTML = c.records.length
        ? c.records
            .map(
              (r) =>
                `<article class="prose" style="margin-top:18px"><h2 style="font-size:15px">${esc(r.title)}</h2>${r.html}</article>`,
            )
            .join('')
        : emptyPanel('还没有学习记录。');
    else if (key === 'resources') panel.innerHTML = `<div class="prose">${c.resourcesHtml || emptyPanel('（空）')}</div>`;
    else if (key === 'notes') panel.innerHTML = `<div class="prose">${c.notesHtml || emptyPanel('（空）')}</div>`;

    if (key === 'lessons') wireLessonRows(c);
  };

  document.querySelectorAll('#tabs button').forEach((b) => {
    b.onclick = () => renderTab(b.dataset.tab);
  });
  renderTab('lessons');
}

function emptyPanel(text) {
  return `<p class="faint small" style="padding:20px 4px">${esc(text)}</p>`;
}

function lessonTitle(title) {
  const text = String(title || '').trim();
  // The row already shows 01/02/…, so "第 1 讲 · " is duplicate noise.
  return text.replace(/^第\s*[0-9一二三四五六七八九十百]+\s*讲\s*[·:：.\-—]?\s*/, '') || text;
}

function lessonRows(lessons) {
  if (!lessons.length) return emptyPanel('还没有课程。让 teach 在这个目录里生成讲义吧。');
  // The first not-done lesson is where this course resumes.
  const nextIdx = lessons.findIndex((l) => (state.progress[l.file] || {}).status !== 'done');
  return `<div class="rows">${lessons
    .map((l, i) => {
      const done = (state.progress[l.file] || {}).status === 'done';
      const isNext = i === nextIdx;
      const sub = isNext ? `继续读${l.words ? ` · ${l.words} 字` : ''}` : l.words ? `${l.words} 字` : '';
      return `
      <div class="row ${done ? 'done' : ''} ${isNext ? 'next-up' : ''}" data-open="1" data-file="${esc(l.file)}" title="${esc(l.title)}">
        <span class="idx">${String(i + 1).padStart(2, '0')}</span>
        <div class="body">
          <div class="t">${esc(lessonTitle(l.title))}</div>
          ${sub ? `<div class="s">${sub}</div>` : ''}
        </div>
        <button class="check ${done ? 'on' : ''}" data-toggle="${esc(l.file)}" title="标记完成">✓</button>
      </div>`;
    })
    .join('')}</div>`;
}

function docRows(docs) {
  if (!docs.length) return emptyPanel('还没有参考资料。');
  return `<div class="rows">${docs
    .map(
      (d) => `
      <div class="row" data-openref="1" data-file="${esc(d.file)}" data-kind="${esc(d.kind)}">
        <span class="idx">§</span>
        <div class="body"><div class="t">${esc(d.title)}</div><div class="s"><span class="dev">${esc(d.file)}</span></div></div>
        <span class="faint">›</span>
      </div>`,
    )
    .join('')}</div>`;
}

function wireLessonRows(course) {
  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const file = btn.dataset.toggle;
      const nowDone = !btn.classList.contains('on');
      btn.classList.toggle('on', nowDone);
      const row = btn.closest('.row');
      if (row) row.classList.toggle('done', nowDone);
      state.progress[file] = nowDone ? { status: 'done' } : undefined;
      try {
        await setProgress(course.id, file, nowDone ? 'done' : 'none');
      } catch (err) {
        toast(err.message);
      }
    };
  });
  document.querySelectorAll('[data-open]').forEach((row) => {
    row.onclick = () => go(`#/read/${encodeURIComponent(course.id)}/lessons/${encodeURIComponent(row.dataset.file)}`);
  });
  document.querySelectorAll('[data-openref]').forEach((row) => {
    row.onclick = () =>
      go(`#/read/${encodeURIComponent(course.id)}/${row.dataset.kind}/${encodeURIComponent(row.dataset.file)}`);
  });
}

// Reader font scale: zoom the lesson document (lessons are standalone HTML
// with px-based styles, so zoom is the only lever that scales everything).
function fontScale() {
  try {
    const v = Number(localStorage.getItem(FONTSCALE_KEY));
    return FONT_STEPS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

function applyReaderFontScale(scale) {
  const frame = document.getElementById('r-frame');
  if (!frame) return;
  try {
    const doc = frame.contentDocument;
    if (doc && doc.body) doc.body.style.zoom = scale === 1 ? '' : String(scale);
  } catch {
    // cross-origin document — nothing to scale
  }
}

// ---------------------------------------------------------------- reader ----

async function renderReader(id, kind, file) {
  setTopbar('');

  // Deep links land straight on a lesson, so the course (and its progress) may
  // not be in memory yet. Reuse it when it is — that's the common case.
  if (!(state.course && state.course.id === id)) {
    try {
      const detail = await loadCourse(id);
      state.course = detail.course;
      state.progress = detail.progress || {};
    } catch {
      /* no course data → still render the file, just without lesson nav */
    }
  }

  const lessons = kind === 'lessons' && state.course ? state.course.lessons || [] : [];
  const at = lessons.findIndex((l) => l.file === file);
  const prev = at > 0 ? lessons[at - 1] : null;
  const next = at >= 0 && at < lessons.length - 1 ? lessons[at + 1] : null;
  const label = at >= 0 ? lessons[at].title : file.replace(/\.html?$/i, '');

  const src = fileUrl(id, kind, file);
  const restore = takeReaderRestore(id, kind);
  const frameSrc = restore ? restore.href : src;
  const done = (state.progress[file] || {}).status === 'done';
  const isLesson = kind === 'lessons';
  app.innerHTML = `
    <div class="reader">
      <div class="rbar">
        <button class="back" id="r-back">‹ 返回</button>
        <div class="rt" title="${esc(file)}">${esc(label)}</div>
        <button class="iconbtn" id="r-font" title="字号">Aa</button>
        ${themeButtonHTML()}
      </div>
      <div class="rprog" id="r-prog"><span></span></div>
      <iframe id="r-frame" src="${esc(frameSrc)}" referrerpolicy="no-referrer"></iframe>
      <div class="rfoot">
        <button class="navbtn" id="r-prev" title="上一讲" aria-label="上一讲" ${prev ? '' : 'disabled'}>${chevron('left')}</button>
        <button class="fbtn done ${done ? 'on' : ''}" id="r-done" title="标记完成">${done ? '已完成' : '✓ 完成'}</button>
        <button class="navbtn" id="r-next" title="下一讲" aria-label="下一讲" ${next ? '' : 'disabled'}>${chevron('right')}</button>
      </div>
    </div>
    <div class="reader-load" id="r-load"></div>`;
  document.body.classList.add('reader-open');

  // Lessons remember where you stopped reading — this is what the 继续阅读
  // strip restores. Throttle the writes; scrolling fires far more often.
  let lastYSave = 0;
  const rememberY = (y, force = false) => {
    if (!isLesson) return;
    const now = Date.now();
    if (!force && now - lastYSave < 1200) return;
    lastYSave = now;
    activeReader = { id, file, title: label };
    saveLastRead({ id, file, title: label, y, at: now });
  };
  rememberY(restore ? restore.y : 0, true);

  // Cover the iframe until the lesson paints, so there's no white flash.
  const frame = document.getElementById('r-frame');
  let pendingScroll = restore ? restore.y : 0;
  frame.addEventListener('load', () => {
    syncReaderTheme(); // in-page links re-load the iframe; re-apply the choice
    applyReaderFontScale(fontScale());
    document.getElementById('r-load').hidden = true;
    if (pendingScroll) {
      const y = pendingScroll;
      pendingScroll = 0;
      try {
        frame.contentWindow.scrollTo(0, y);
      } catch {
        // cross-origin — nothing to restore
      }
    }
    // Track reading progress + position. Same-origin in both modes (the files
    // are served alongside the app), so this normally attaches fine.
    let win;
    try {
      win = frame.contentWindow;
    } catch {
      return;
    }
    if (!win || !win.document) return;
    const prog = document.getElementById('r-prog');
    const update = () => {
      try {
        const doc = win.document;
        const root = doc.documentElement;
        const max = (root.scrollHeight || doc.body.scrollHeight) - win.innerHeight;
        if (prog) {
          const pct = max > 0 ? Math.min(100, Math.round((win.scrollY / max) * 100)) : 0;
          prog.firstElementChild.style.width = `${pct}%`;
        }
        rememberY(win.scrollY);
      } catch {
        // cross-origin navigated away — stop tracking
      }
    };
    win.addEventListener('scroll', update, { passive: true });
    update();
  });

  // "Back" in the reader means the course index, not the previous lesson.
  // history.back() would land on the last lesson read via the ‹ / › buttons.
  document.getElementById('r-back').onclick = () => go(`#/c/${encodeURIComponent(id)}`);

  const gotoLesson = (l) => go(`#/read/${encodeURIComponent(id)}/lessons/${encodeURIComponent(l.file)}`);
  if (prev) document.getElementById('r-prev').onclick = () => gotoLesson(prev);
  if (next) document.getElementById('r-next').onclick = () => gotoLesson(next);

  // Arrow keys read like a book on a desktop browser.
  readerKeys = (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft' && prev) gotoLesson(prev);
    else if (e.key === 'ArrowRight' && next) gotoLesson(next);
  };
  document.addEventListener('keydown', readerKeys);

  document.getElementById('r-font').onclick = () => {
    const nextScale = FONT_STEPS[(FONT_STEPS.indexOf(fontScale()) + 1) % FONT_STEPS.length];
    try {
      localStorage.setItem(FONTSCALE_KEY, String(nextScale));
    } catch {
      // still applies for this visit
    }
    applyReaderFontScale(nextScale);
    toast(`字号 ${nextScale === 1 ? '默认' : `${Math.round(nextScale * 100)}%`}`);
  };

  const btn = document.getElementById('r-done');
  btn.onclick = async () => {
    const nowDone = !(state.progress[file] || {}).status;
    state.progress[file] = nowDone ? { status: 'done' } : undefined;
    btn.classList.toggle('on', nowDone);
    btn.textContent = nowDone ? '已完成' : '✓ 完成';
    toast(nowDone ? '已标记完成' : '已取消完成');
    try {
      await setProgress(id, file, nowDone ? 'done' : 'none');
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------------------------------------------------------------- search ----

async function renderSearch(q) {
  setTopbar(`
    <button class="back" id="btn-back">‹ 返回</button>
    <div class="spacer"></div>
    ${themeButtonHTML()}
  `);
  document.getElementById('btn-back').onclick = () => go('#/');

  app.innerHTML = `
    <div class="search">
      <span class="glass">⌕</span>
      <input id="q" placeholder="搜索课程、讲义、学习记录…" value="${esc(q)}" enterkeyhint="search" />
    </div>
    <div id="results"></div>
  `;
  const input = document.getElementById('q');
  const box = document.getElementById('results');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go(`#/search?q=${encodeURIComponent(input.value.trim())}`);
  });
  wireLiveSearch(input, box);
  if (!q) {
    box.innerHTML = emptyPanel('输入关键词开始搜索。');
    return;
  }
  liveSearch(q, box);
}

// ----------------------------------------------------------------- sheet ----
// (Removed: new topics are always created by an agent / teach workflow,
//  never through the UI.)

// ------------------------------------------------------------------ boot ----

window.addEventListener('hashchange', render);
window.addEventListener('pagehide', flushActiveReaderY);

(async function boot() {
  applyTheme(currentTheme(), false); // sync meta color + buttons with the pre-paint choice
  if (!STATIC) {
    // Surfaces a login redirect via api() if a password is set.
    try {
      await api('/api/state');
    } catch {
      // ignore — render will surface any auth problem
    }
  }
  if (!location.hash) location.hash = '#/';
  const restoreY = takeScrollRestore();
  await render();
  if (restoreY) requestAnimationFrame(() => window.scrollTo(0, restoreY));
})();
