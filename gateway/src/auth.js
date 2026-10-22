import crypto from 'node:crypto';
import { store } from './store.js';
import { cfg } from './config.js';

// 单用户鉴权：密码 scrypt 哈希存本地记录；会话用随机令牌 Cookie
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expected) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 当前生效的账号：优先本地记录（界面里设置/改过的），否则环境变量
export function account() {
  if (store.data.auth) return { user: store.data.auth.user, source: 'store' };
  if (cfg.panelUser && cfg.panelPassword) return { user: cfg.panelUser, source: 'env' };
  return null;
}
export function needsSetup() { return account() === null; }

export function checkCredentials(user, password) {
  const acc = account();
  if (!acc || user !== acc.user) return false;
  if (acc.source === 'store') return verifyPassword(password, store.data.auth.salt, store.data.auth.hash);
  // env 账号：常量时间比较
  const a = Buffer.from(String(password));
  const b = Buffer.from(cfg.panelPassword);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function setPassword(user, password) {
  const { salt, hash } = hashPassword(password);
  store.data.auth = { user, salt, hash };
  store.save();
}

// 会话（进程内保存，网关重启后需重新登录，可接受）
const sessions = new Map(); // token -> {user, expires}
const SESSION_MS = 30 * 24 * 3600 * 1000;
export function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, expires: Date.now() + SESSION_MS });
  return token;
}
export function sessionUser(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  s.expires = Date.now() + SESSION_MS; // 滑动续期
  return s.user;
}
export function dropSession(token) { sessions.delete(token); }

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export const SESSION_COOKIE = 'rclona_session';
export function sessionCookieHeader(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`;
}
export function clearCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// 登录失败限流：同一来源 5 次失败锁 5 分钟
const fails = new Map();
export function loginLocked(ip) {
  const f = fails.get(ip);
  return f && f.count >= 5 && Date.now() - f.last < 5 * 60 * 1000;
}
export function noteLoginFail(ip) {
  const f = fails.get(ip) || { count: 0, last: 0 };
  f.count += 1; f.last = Date.now();
  fails.set(ip, f);
}
export function noteLoginOk(ip) { fails.delete(ip); }
