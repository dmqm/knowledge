// Pure route/URL logic that the reader and the search page share. No DOM, no
// network — just the parsing/encoding rules that used to drift.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORRUPT_PROGRESS_KEY,
  courseStats,
  createRetryLoader,
  decodeSegment,
  encodeSegment,
  loadLocalProgress,
  readerHash,
  routeFromFilePath,
  routeFromIndexUrl,
  sameRoute,
} from '../public/route-logic.js';

const TRICKY = '第 1 讲 #1 & 100% 完成.html';

test('routeFromFilePath reads a server-mode file path', () => {
  assert.deepEqual(routeFromFilePath('/files/webrtc/lessons/0002-sdp-offer-answer.html'), {
    courseId: 'webrtc',
    kind: 'lessons',
    file: '0002-sdp-offer-answer.html',
  });
  assert.deepEqual(routeFromFilePath('/files/webrtc/reference/0001-glossary.html'), {
    courseId: 'webrtc',
    kind: 'reference',
    file: '0001-glossary.html',
  });
});

test('routeFromFilePath tolerates a static-build sub-path', () => {
  assert.deepEqual(routeFromFilePath('/knowledge/files/c/learning-records/01-r.md'), {
    courseId: 'c',
    kind: 'learning-records',
    file: '01-r.md',
  });
});

test('routeFromFilePath ignores unrelated or malformed paths', () => {
  assert.equal(routeFromFilePath('/assets/app.js'), null);
  assert.equal(routeFromFilePath('/files/c/lessons/'), null);
  assert.equal(routeFromFilePath('/files/c/notes/x.html'), null);
  assert.equal(routeFromFilePath('/other/c/lessons/x.html'), null);
  assert.equal(routeFromFilePath(''), null);
  assert.equal(routeFromFilePath(null), null);
});

test('names with spaces, CJK, #, & and % survive the hash round-trip', () => {
  const file = TRICKY;
  const hash = readerHash('c', 'lessons', file);
  // Encoded exactly once: a space is one %20, never %2520.
  assert.match(hash, /%20/);
  assert.doesNotMatch(hash, /%2520/);
  assert.ok(!hash.includes(' '));
  // The # must be encoded or it would start the fragment again.
  assert.ok(!hash.slice(1).includes('#'));

  const path = `/files/${encodeSegment('c')}/lessons/${encodeSegment(file)}`;
  const route = routeFromFilePath(path);
  assert.equal(route.file, file);

  const segment = hash.split('/').pop();
  assert.equal(decodeSegment(segment), file);
  assert.equal(segment, encodeSegment(file));
});

test('routeFromIndexUrl does not encode an already-encoded url twice', () => {
  const file = '01 中文 讲义.html';
  const url = `/files/webrtc/lessons/${encodeURIComponent(file)}`;
  // The old code did encodeURIComponent(url.split('/').pop()) on this, giving
  // 01%2520%25E4… and a 404.
  assert.ok(url.includes('%20'));

  const route = routeFromIndexUrl(url);
  assert.deepEqual(route, { courseId: 'webrtc', kind: 'lessons', file });

  const hash = readerHash(route.courseId, route.kind, route.file);
  assert.doesNotMatch(hash, /%2520/);
  assert.equal(decodeSegment(hash.split('/').pop()), file);
});

test('routeFromIndexUrl returns null for a mission entry', () => {
  assert.equal(routeFromIndexUrl(null), null);
  assert.equal(routeFromIndexUrl(''), null);
});

test('decodeSegment tolerates a stray percent sign', () => {
  assert.equal(decodeSegment('100%'), '100%');
  assert.equal(decodeSegment('%E4%B8%AD'), '中');
});

test('sameRoute compares all three fields', () => {
  const a = { courseId: 'c', kind: 'lessons', file: 'a.html' };
  assert.equal(sameRoute(a, { ...a }), true);
  assert.equal(sameRoute(a, { ...a, file: 'b.html' }), false);
  assert.equal(sameRoute(a, null), false);
});

test('courseStats counts objects and plain file names', () => {
  const progress = {
    'a.html': { status: 'done' },
    'b.html': { status: 'reading' },
    'c.html': { status: 'done' },
  };
  const objects = [{ file: 'a.html' }, { file: 'b.html' }, { file: 'c.html' }, { file: 'd.html' }];
  assert.deepEqual(courseStats(objects, progress), { done: 2, total: 4, pct: 50 });
  assert.deepEqual(courseStats(['a.html', 'c.html'], progress), { done: 2, total: 2, pct: 100 });
  assert.deepEqual(courseStats(objects, {}), { done: 0, total: 4, pct: 0 });
  assert.deepEqual(courseStats([], progress), { done: 0, total: 0, pct: 0 });
  assert.deepEqual(courseStats(undefined, progress), { done: 0, total: 0, pct: 0 });
});

// --- static progress quarantine ---------------------------------------------

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    dump: () => Object.fromEntries(map),
  };
}

test('valid local progress is returned untouched', () => {
  const data = { courses: { demo: { lessons: { '01.html': { status: 'done' } } } } };
  const storage = fakeStorage({ 'lc:progress': JSON.stringify(data) });
  const { progress, warning, readOnly } = loadLocalProgress(storage, 'lc:progress');
  assert.deepEqual(progress, data);
  assert.equal(warning, null);
  assert.equal(readOnly, false);
  assert.equal(storage.getItem(CORRUPT_PROGRESS_KEY), null);
});

test('corrupt local progress is copied aside before the store is reset', () => {
  const bad = '{"courses": {"demo": ';
  const storage = fakeStorage({ 'lc:progress': bad });
  const { progress, warning } = loadLocalProgress(storage, 'lc:progress');
  assert.deepEqual(progress, { courses: {} });
  assert.match(warning, /进度文件损坏/);
  assert.match(warning, new RegExp(CORRUPT_PROGRESS_KEY));
  // The bad bytes survive under the side key, and the live key is valid again.
  assert.equal(storage.getItem(CORRUPT_PROGRESS_KEY), bad);
  assert.deepEqual(JSON.parse(storage.getItem('lc:progress')), { courses: {} });

  // Second read sees a clean store and does NOT overwrite the saved backup.
  const again = loadLocalProgress(storage, 'lc:progress');
  assert.equal(again.warning, null);
  assert.deepEqual(again.progress, { courses: {} });
  assert.equal(storage.getItem(CORRUPT_PROGRESS_KEY), bad);
});

test('a structurally invalid local store (courses not an object) is quarantined too', () => {
  const bad = JSON.stringify({ courses: [] });
  const storage = fakeStorage({ 'lc:progress': bad });
  const { progress, warning } = loadLocalProgress(storage, 'lc:progress');
  assert.deepEqual(progress, { courses: {} });
  assert.match(warning, /进度文件损坏/);
  assert.equal(storage.getItem(CORRUPT_PROGRESS_KEY), bad);
});

test('an unwritable backup leaves the bad local store untouched and goes read-only', () => {
  const bad = '{oops';
  const writes = [];
  const storage = {
    getItem: () => bad,
    setItem: (key, value) => {
      writes.push(key);
      // Only the side-key backup fails; writing the live key would succeed.
      if (key === CORRUPT_PROGRESS_KEY) throw new Error('QuotaExceededError');
    },
  };
  const { progress, warning, readOnly } = loadLocalProgress(storage, 'lc:progress');
  assert.deepEqual(progress, { courses: {} });
  assert.match(warning, /无法备份/);
  assert.equal(readOnly, true);
  // The live key was never overwritten: nothing was destroyed.
  assert.deepEqual(writes, [CORRUPT_PROGRESS_KEY]);
  assert.equal(storage.getItem('lc:progress'), bad);
});

// --- static search-index retry gate -----------------------------------------

test('index loader retries automatically once, then waits for a manual retry', async () => {
  let calls = 0;
  const loader = createRetryLoader(async () => {
    calls += 1;
    throw new Error('HTTP 500');
  });

  await assert.rejects(loader.get(), /500/);
  assert.equal(calls, 1);
  // A different keyword would use the same loader; the retry is not keyed.
  await assert.rejects(loader.get(), /500/);
  assert.equal(calls, 2, 'second search retries once automatically');
  await assert.rejects(loader.get(), /500/);
  assert.equal(calls, 2, 'after a second consecutive failure, no more auto retries');
  await assert.rejects(loader.get({ manual: true }), /500/);
  assert.equal(calls, 3, 'the explicit retry button fetches again');
});

test('index loader caches success and resets the failure count', async () => {
  let calls = 0;
  let fail = true;
  const loader = createRetryLoader(async () => {
    calls += 1;
    if (fail) throw new Error('boom');
    return [{ text: 'hello' }];
  });

  await assert.rejects(loader.get(), /boom/);
  fail = false;
  assert.deepEqual(await loader.get(), [{ text: 'hello' }]);
  assert.equal(calls, 2);
  // Subsequent searches are served from the cache, not the network.
  assert.deepEqual(await loader.get(), [{ text: 'hello' }]);
  assert.equal(calls, 2);
});

test('concurrent index loads share one request', async () => {
  let calls = 0;
  const loader = createRetryLoader(async () => {
    calls += 1;
    return ['x'];
  });
  const [a, b] = await Promise.all([loader.get(), loader.get()]);
  assert.deepEqual(a, ['x']);
  assert.deepEqual(b, ['x']);
  assert.equal(calls, 1);
});
