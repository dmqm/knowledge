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

const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
const toastEl = document.getElementById('toast');

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

const state = { courses: [], course: null, progress: {} };

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
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
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
    });
    if (results.length >= 60) break;
  }
  return results;
}

async function searchCourses(q) {
  if (STATIC) return searchLocally(await searchIndex(), q);
  const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
  return results;
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
const SWAP_KEY = 'lc:theme-swap';
const RESTORE_TTL = 120000;
let themeSwapping = false;
let arrivalFinishing = false;

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

function reduceMotion() {
  return !!(
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// Reload immediately: iOS only re-reads the status-bar style as the document
// loads, and a navigation started inside the tap handler is the reliable path.
// The next document covers its first paint with the destination colour (via the
// short-lived flag), so the reload still reads as a fade rather than a flash.
function beginIOSThemeSwap(theme) {
  themeSwapping = true;
  try {
    sessionStorage.setItem(SWAP_KEY, JSON.stringify({ at: Date.now(), theme }));
  } catch {
    // no arrival cover; the reload is still correct
  }
  commitTheme(theme);
  location.reload();
}

// Called once the restored page (or the reader iframe) has painted.
function finishThemeArrival() {
  const root = document.documentElement;
  if (!root.classList.contains('lc-arriving') || arrivalFinishing) return;
  arrivalFinishing = true;
  const cover = document.getElementById('lc-swap-style');
  const done = () => {
    root.classList.remove('lc-arriving', 'lc-arriving-out');
    if (cover) cover.remove();
    // Let normal browser back/forward scroll behaviour resume after this load.
    try {
      history.scrollRestoration = 'auto';
    } catch {
      // unsupported — nothing to restore
    }
  };
  if (reduceMotion()) {
    done();
    return;
  }
  requestAnimationFrame(() => {
    root.classList.add('lc-arriving-out');
    window.setTimeout(done, 240);
  });
}

// Apply a palette to the current document. Kept separate from the reload path so
// the reload can update the meta before navigating.
function commitTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  // Phone status bar / browser chrome: tint it to the reading surface, and let
  // the iOS status bar text invert too when the site runs as a home-screen app.
  setMetaContent('theme-color', THEME_COLOR[theme]);
  setMetaContent(
    'apple-mobile-web-app-status-bar-style',
    theme === 'dark' ? 'black-translucent' : 'default',
  );
  syncThemeButtons();
  syncReaderTheme();
}

function applyTheme(theme, persist = true) {
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage disabled — the switch still works for this visit
    }
  }

  // `persist` is only true for a real tap; boot and system-follow never reload.
  if (persist && isIOSStandalone()) {
    // Park where the reader was, then reload so iOS re-reads the status bar
    // style from the pre-paint script. The hash already restores the route.
    if (!saveReaderRestore()) saveScrollRestore();
    beginIOSThemeSwap(theme);
    return;
  }

  commitTheme(theme);
}

// One delegated handler survives every re-render of the topbar / reader bar.
document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('[data-theme-toggle]') : null;
  if (!btn || themeSwapping) return;
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
    <div class="chips" id="catbar" hidden></div>
    <div id="courselist"></div>
  `;
  homeFilter = null;

  const q = document.getElementById('q');
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && q.value.trim()) go(`#/search?q=${encodeURIComponent(q.value.trim())}`);
  });
  q.addEventListener('input', () => {
    if (!q.value.trim()) return;
    clearTimeout(q._t);
    q._t = setTimeout(() => go(`#/search?q=${encodeURIComponent(q.value.trim())}`), 500);
  });

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
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="big">⚠︎</div>${esc(err.message)}</div>`;
  }
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
        <span class="dirpath">courses/${esc(c.id)}</span>
      </div>
      ${c.counts.lessons ? `<div class="bar"><span style="width:${c.counts.lessons ? Math.round((done / c.counts.lessons) * 100) : 0}%"></span></div>` : ''}
      <div class="btnrow">
        <button class="btn ghost small" id="btn-toggle-mission">查看使命</button>
        <a class="btn ghost small" style="text-align:center" href="#/search?q=">搜索</a>
      </div>
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

function lessonRows(lessons) {
  if (!lessons.length) return emptyPanel('还没有课程。让 teach 在这个目录里生成讲义吧。');
  return `<div class="rows">${lessons
    .map((l, i) => {
      const done = (state.progress[l.file] || {}).status === 'done';
      return `
      <div class="row ${done ? 'done' : ''}" data-open="1" data-file="${esc(l.file)}">
        <span class="idx">${String(i + 1).padStart(2, '0')}</span>
        <div class="body">
          <div class="t">${esc(l.title)}</div>
          <div class="s">${l.words ? `${l.words} 词` : ''}<span class="dev">${l.words ? ' · ' : ''}${esc(l.file)}</span></div>
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
  app.innerHTML = `
    <div class="reader">
      <div class="rbar">
        <button class="back" id="r-back">‹ 返回</button>
        <div class="rt" title="${esc(file)}">${esc(label)}</div>
        <button class="iconbtn nav" id="r-prev" title="上一讲" ${prev ? '' : 'disabled'}>‹</button>
        <button class="iconbtn nav" id="r-next" title="下一讲" ${next ? '' : 'disabled'}>›</button>
        ${themeButtonHTML()}
        <button class="iconbtn" id="r-done" title="标记完成" style="${done ? 'background:var(--good);border-color:var(--good);color:#fff' : ''}">✓</button>
        <a class="iconbtn open-tab" href="${esc(src)}" target="_blank" rel="noopener" title="新标签打开">⤢</a>
      </div>
      <iframe id="r-frame" src="${esc(frameSrc)}" referrerpolicy="no-referrer"></iframe>
    </div>
    <div class="reader-load" id="r-load"></div>`;
  document.body.classList.add('reader-open');

  // Cover the iframe until the lesson paints, so there's no white flash.
  const frame = document.getElementById('r-frame');
  let pendingScroll = restore ? restore.y : 0;
  frame.addEventListener('load', () => {
    // A freshly inserted iframe can emit a load for about:blank; ignore that,
    // and ignore cross-origin pages we cannot reach into.
    let href = '';
    try {
      href = frame.contentWindow.location.href;
    } catch {
      return;
    }
    if (!href || href === 'about:blank') return;

    syncReaderTheme(); // in-page links re-load the iframe; re-apply the choice
    if (pendingScroll) {
      const y = pendingScroll;
      pendingScroll = 0;
      try {
        frame.contentWindow.scrollTo(0, y);
      } catch {
        // cross-origin — nothing to restore
      }
    }

    // Reveal only after the scroll is in place, otherwise the lesson paints at
    // the top for a frame and then visibly jumps to the restored position.
    const veil = document.getElementById('r-load');
    if (veil) {
      if (document.documentElement.classList.contains('lc-arriving')) {
        // The theme-swap cover is still opaque; let its fade do the reveal.
        veil.hidden = true;
        finishThemeArrival();
      } else {
        requestAnimationFrame(() => {
          veil.classList.add('is-hidden');
          window.setTimeout(() => {
            veil.hidden = true;
          }, reduceMotion() ? 0 : 200);
        });
      }
    } else {
      finishThemeArrival();
    }
  });

  document.getElementById('r-back').onclick = () => history.back();

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

  const btn = document.getElementById('r-done');
  btn.onclick = async () => {
    const nowDone = !(state.progress[file] || {}).status;
    state.progress[file] = nowDone ? { status: 'done' } : undefined;
    btn.style.cssText = nowDone ? 'background:var(--good);border-color:var(--good);color:#fff' : '';
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
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go(`#/search?q=${encodeURIComponent(input.value.trim())}`);
  });
  if (!q) {
    document.getElementById('results').innerHTML = emptyPanel('输入关键词开始搜索。');
    return;
  }

  const box = document.getElementById('results');
  box.innerHTML = '<div class="spinner">搜索中…</div>';
  try {
    const results = await searchCourses(q);
    if (!results.length) {
      box.innerHTML = emptyPanel(`没有找到「${q}」。`);
      return;
    }
    box.innerHTML = `<div class="section-title">${results.length} 条结果</div>
      <div class="rows">${results
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
  } catch (err) {
    box.innerHTML = `<div class="empty"><div class="big">⚠︎</div>${esc(err.message)}</div>`;
  }
}

// ----------------------------------------------------------------- sheet ----
// (Removed: new topics are always created by an agent / teach workflow,
//  never through the UI.)

// ------------------------------------------------------------------ boot ----

window.addEventListener('hashchange', render);

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
  if (restoreY) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    window.scrollTo(0, restoreY);
  }
  if (!document.getElementById('r-frame')) {
    finishThemeArrival();
  } else {
    // Safety net: the reader normally clears the cover from its load handler.
    window.setTimeout(finishThemeArrival, 3000);
  }
})();
