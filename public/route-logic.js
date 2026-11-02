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
