// Minimal password gate for the learning center.
//
// Off by default (loopback-only use). When a password is configured, every
// request needs a signed session cookie. The cookie is stateless and signed
// with a secret persisted in `data/secret`, so sessions survive restarts.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function makeAuth({ password, secretFile }) {
  if (!password) {
    return { required: false };
  }

  let secret;
  try {
    secret = (await fs.readFile(secretFile, 'utf8')).trim();
  } catch {
    secret = '';
  }
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    await fs.mkdir(path.dirname(secretFile), { recursive: true });
    await fs.writeFile(secretFile, secret);
  }

  const sign = (exp) => crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');

  function issue() {
    const exp = Date.now() + TTL_MS;
    return `${exp}.${sign(exp)}`;
  }

  function verifyCookie(value) {
    if (!value) return false;
    const [expStr, sig] = String(value).split('.');
    const exp = Number(expStr);
    if (!exp || !sig || Date.now() > exp) return false;
    const good = sign(exp);
    const a = Buffer.from(sig);
    const b = Buffer.from(good);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function checkPassword(candidate) {
    const a = Buffer.from(String(candidate ?? ''));
    const b = Buffer.from(password);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  return { required: true, issue, verifyCookie, checkPassword };
}
