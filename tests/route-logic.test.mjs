// Pure route/URL logic that the reader and the search page share. No DOM, no
// network — just the parsing/encoding rules that used to drift.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  courseStats,
  decodeSegment,
  encodeSegment,
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
