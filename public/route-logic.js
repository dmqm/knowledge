// Pure navigation/URL helpers shared by the portal (public/app.js) and the
// node:test suite. No DOM access here on purpose — this module is imported by
// the browser (as `/assets/route-logic.js`) and by `node --test`.
//
// Two invariants live here so they can be tested and can never drift:
//   - the parent hash is the single navigation source, so every route is built
//     by `readerHash()` and read back by `routeFromFilePath()`;
//   - a path segment is percent-encoded exactly once: the scanner already
//     encodes index urls, and encoding them a second time turned `a b.html`
//     into `a%2520b.html` (a 404).

const READER_KINDS = new Set(['lessons', 'reference', 'learning-records']);

// Decode one path segment, tolerating a stray `%` (a real file name may
// contain one).
export function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Encode one path segment exactly once, whatever it contains: spaces, CJK,
// `#`, `&`, `%`.
export function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

// `/files/<course>/<kind>/<file>` → { courseId, kind, file }. Accepts a
// static-build prefix (`/repo/files/...`) too. Returns null for anything else,
// so an iframe that lands on an unrelated page never hijacks the parent route.
export function routeFromFilePath(pathname) {
  const parts = String(pathname || '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 4) return null;
  const file = parts[parts.length - 1];
  const kind = parts[parts.length - 2];
  const courseId = parts[parts.length - 3];
  const base = parts[parts.length - 4];
  if (base !== 'files' || !READER_KINDS.has(kind) || !courseId || !file) return null;
  return { courseId: decodeSegment(courseId), kind, file: decodeSegment(file) };
}

// The one way to build a reader hash. Search results, the iframe sync and the
// prev/next buttons all go through it, so they cannot disagree.
export function readerHash(courseId, kind, file) {
  return `#/read/${encodeSegment(courseId)}/${kind}/${encodeSegment(file)}`;
}

// Search-index urls are already encoded by the scanner. Parse them without
// encoding again (double-encoding broke names with spaces/CJK).
export function routeFromIndexUrl(url) {
  return routeFromFilePath(url);
}

export function sameRoute(a, b) {
  return (
    !!a && !!b && a.courseId === b.courseId && a.kind === b.kind && a.file === b.file
  );
}

// done/total for a lesson list. Shared by the course hero, the home cards and
// the tests. Lessons may be objects ({ file }) or plain file names (static
// home list).
export function courseStats(lessons, progress) {
  const list = Array.isArray(lessons) ? lessons : [];
  let done = 0;
  for (const lesson of list) {
    const file = typeof lesson === 'string' ? lesson : lesson && lesson.file;
    if (file && progress && progress[file] && progress[file].status === 'done') done += 1;
  }
  const total = list.length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// ------------------------------------------------------------ static store ----
// Browser-local progress lives in localStorage under `lc:progress`. A corrupt
// value used to be dropped silently, so the user's history vanished with no
// trace. Now the bad bytes are copied to a side key before the store is reset,
// and the caller gets a warning it can show once.

export const CORRUPT_PROGRESS_KEY = '__lc_progress_corrupt';

function emptyLocalProgress() {
  return { courses: {} };
}

function isProgressShape(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !!value.courses &&
    typeof value.courses === 'object' &&
    !Array.isArray(value.courses)
  );
}

export function loadLocalProgress(storage, key = 'lc:progress') {
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    // Storage disabled — fall back to an in-memory empty store, no warning.
    return { progress: emptyLocalProgress(), warning: null, readOnly: false };
  }
  if (raw == null) return { progress: emptyLocalProgress(), warning: null, readOnly: false };

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (isProgressShape(parsed)) return { progress: parsed, warning: null, readOnly: false };

  // Keep the bad value before touching the live key. If even that write fails
  // the live key is left exactly as it was (read-only for this session)
  // instead of being reset with nothing to recover it from.
  let backedUp = false;
  try {
    storage.setItem(CORRUPT_PROGRESS_KEY, raw);
    backedUp = true;
  } catch {
    backedUp = false;
  }
  const progress = emptyLocalProgress();
  if (backedUp) {
    try {
      storage.setItem(key, JSON.stringify(progress));
    } catch {
      // Can't reset; the next read quarantines again (backup stays intact).
    }
  }
  const warning = backedUp
    ? `进度文件损坏，已备份为 ${CORRUPT_PROGRESS_KEY}，当前为空白进度`
    : `进度文件损坏，无法备份（浏览器存储不可写），已切换为只读，当前为空白进度`;
  return { progress, warning, readOnly: !backedUp };
}

// --------------------------------------------------------------- retrying ----
// A failed static search-index fetch used to be cached until a page reload.
// Now the first failure arms exactly one automatic retry (the next search,
// whatever the keyword), and further searches are refused until the user taps
// the explicit retry button. No timers, no polling: attempts only happen on a
// search or a manual retry.
export function createRetryLoader(load, { maxAutoAttempts = 2 } = {}) {
  let cache;
  let hasCache = false;
  let pending = null;
  let attempts = 0; // consecutive automatic attempts since the last success
  let lastError = null;

  function get({ manual = false } = {}) {
    if (hasCache) return Promise.resolve(cache);
    if (pending) return pending;
    if (!manual && lastError && attempts >= maxAutoAttempts) {
      return Promise.reject(lastError);
    }
    if (manual) attempts = 0;
    attempts += 1;
    pending = (async () => {
      try {
        const value = await load();
        cache = value;
        hasCache = true;
        attempts = 0;
        lastError = null;
        return value;
      } catch (err) {
        lastError = err;
        throw err;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  return { get };
}
