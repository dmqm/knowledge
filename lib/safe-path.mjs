// Path-containment helpers shared by the server and the static exporter.
//
// Zero dependencies. Every check runs on resolved *real* paths (symlinks and
// junctions followed), so a link inside `courses/` cannot be used to reach a
// file outside it. Windows paths are compared case-insensitively and with the
// same drive letter, as the filesystem itself does.
//
// Everything here fails closed: when the real location cannot be established
// the caller is expected to reject, not to fall back to the raw string.

import fs from 'node:fs';
import path from 'node:path';

const WINDOWS = process.platform === 'win32';

function norm(p) {
  const abs = path.resolve(p);
  return WINDOWS ? abs.toLowerCase() : abs;
}

// True when `child` is `parent` itself or lives anywhere beneath it.
export function isSameOrInside(parent, child) {
  const p = norm(parent);
  const c = norm(child);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// True when `child` lives strictly beneath `parent`.
export function isInside(parent, child) {
  return isSameOrInside(parent, child) && norm(parent) !== norm(child);
}

// Resolve a path to its real location. Components that do not exist yet are
// appended to the nearest ancestor that does resolve, so an output directory
// that is about to be created is still checked against the real location of
// its parent (a symlinked parent cannot smuggle it elsewhere).
export function realPath(p) {
  let abs = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(abs);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(abs);
      if (parent === abs) return path.resolve(p);
      tail.push(path.basename(abs));
      abs = parent;
    }
  }
}

// Keys that would rewrite an object's prototype if used as a property name.
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isProtoKey(value) {
  return PROTO_KEYS.has(String(value));
}

// A single, flat path segment: no separators, no NUL/control characters, no
// reserved prototype keys. On Windows also no characters the filesystem
// rejects (or that switch to a device/stream: `C:`, `*`, `?`, ...).
export function isSafePathSegment(value, { allowDot = true } = {}) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 255) return false;
  if (value === '.' || value === '..') return false;
  if (isProtoKey(value)) return false;
  if (/[/\\]/.test(value)) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (WINDOWS && /[:*?"<>|]/.test(value)) return false;
  // Windows silently strips trailing dots/spaces and treats device names as
  // devices ("CON", "NUL", "COM1", ...) at any directory level.
  if (WINDOWS && /[. ]$/.test(value)) return false;
  if (WINDOWS && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(value)) return false;
  if (!allowDot && value.startsWith('.')) return false;
  if (value !== value.trim()) return false;
  return true;
}

// Course ids are directory names directly under the content root. The scanner
// skips dot directories, so the lookup/delete API must skip them too.
export function isSafeCourseId(value) {
  return isSafePathSegment(value, { allowDot: false });
}
