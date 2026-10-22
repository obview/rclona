import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { store, newId } from './store.js';
import {
  account, needsSetup, checkCredentials, setPassword,
  createSession, sessionUser, dropSession, parseCookies,
  SESSION_COOKIE, sessionCookieHeader, clearCookieHeader,
  loginLocked, noteLoginFail, noteLoginOk
} from './auth.js';
import { rc, normalizeProviders, fsSpec } from './rc.js';
import { healthOf, testRemote } from './health.js';
import { runTask, isRunning } from './runner.js';
import { sendTestMail } from './mailer.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 2 * 1024 * 1024) throw new Error('请求体过大'); chunks.push(c); }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

let providersCache = null;
async function providers() {
  if (!providersCache) {
    const raw = await rc.providers();
    const norm = normalizeProviders(raw);
    // 常用类型排前面，其余按字母序（方便前端下拉）
    const ORDER = ['s3', 'koofr', 'webdav', 'local'];
    const out = {};
    for (const t of ORDER) if (norm[t]) out[t] = norm[t];
    for (const t of Object.keys(norm).sort()) if (!out[t]) out[t] = norm[t];
    providersCache = out;
  }
  return providersCache;
}

async function remoteList() {
  const names = await rc.listRemotes();
  const out = [];
  for (const name of names) {
    let type = '';
    try { const c = await rc.getRemote(name); type = c.type || ''; } catch { /* 忽略 */ }
    out.push({ name, type, health: healthOf(name) });
  }
  return out;
}

const REMOTE_NAME_RE = /^[A-Za-z0-9_.\-]+$/;

export function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      // ---------- API ----------
      if (p.startsWith('/api/')) {
        const cookies = parseCookies(req);
        const token = cookies[SESSION_COOKIE];
        const user = sessionUser(token);

        if (p === '/api/auth/me' && req.method === 'GET') {
          return sendJson(res, 200, {
            authed: !!user, user: user || null,
            needsSetup: needsSetup(),
            suggestedUser: cfg.panelUser || 'admin'
          });
        }
        if (p === '/api/auth/setup' && req.method === 'POST') {
          if (!needsSetup()) return sendJson(res, 400, { error: '账号已经设置过了' });
          const b = await readBody(req);
          const u = String(b.user || '').trim();
          if (!u || String(b.password || '').length < 8) return sendJson(res, 400, { error: '账号不能为空，密码至少 8 位' });
          setPassword(u, String(b.password));
          const t = createSession(u);
          res.setHeader('Set-Cookie', sessionCookieHeader(t));
          return sendJson(res, 200, { ok: true });
        }
        if (p === '/api/auth/login' && req.method === 'POST') {
          const ip = req.socket.remoteAddress || '';
          if (loginLocked(ip)) return sendJson(res, 429, { error: '输错太多次，请 5 分钟后再试' });
          const b = await readBody(req);
          if (!checkCredentials(String(b.user || ''), String(b.password || ''))) {
            noteLoginFail(ip);
            return sendJson(res, 401, { error: '账号或密码不对' });
          }
          noteLoginOk(ip);
          const t = createSession(String(b.user));
          res.setHeader('Set-Cookie', sessionCookieHeader(t));
          return sendJson(res, 200, { ok: true });
        }
        // 以下都需要登录
        if (!user) return sendJson(res, 401, { error: '请先登录' });

        if (p === '/api/auth/logout' && req.method === 'POST') {
          dropSession(token);
          res.setHeader('Set-Cookie', clearCookieHeader());
          return sendJson(res, 200, { ok: true });
        }
        if (p === '/api/auth/password' && req.method === 'POST') {
          const b = await readBody(req);
          const acc = account();
          if (!acc || !checkCredentials(acc.user, String(b.oldPassword || ''))) {
            return sendJson(res, 400, { error: '当前密码不对' });
          }
          if (String(b.newPassword || '').length < 8) return sendJson(res, 400, { error: '新密码至少 8 位' });
          setPassword(acc.user, String(b.newPassword));
          return sendJson(res, 200, { ok: true });
        }

        if (p === '/api/overview' && req.method === 'GET') {
          return sendJson(res, 200, {
            remotes: await remoteList(),
            tasks: store.data.tasks,
            runs: store.data.runs.slice(0, 20)
          });
        }

        // ---------- 网盘 ----------
        if (p === '/api/remotes' && req.method === 'GET') {
          return sendJson(res, 200, { remotes: await remoteList() });
        }
        if (p === '/api/remotes/providers' && req.method === 'GET') {
          return sendJson(res, 200, { providers: await providers() });
        }
        if (p === '/api/remotes' && req.method === 'POST') {
          const b = await readBody(req);
          const name = String(b.name || '').trim();
          const type = String(b.type || '').trim();
          if (!REMOTE_NAME_RE.test(name)) return sendJson(res, 400, { error: '网盘名只能用英文字母、数字、下划线、横线和点' });
          if (!type) return sendJson(res, 400, { error: '请选择网盘类型' });
          const names = await rc.listRemotes();
          if (names.includes(name)) return sendJson(res, 400, { error: '已有同名网盘' });
          const params = {};
          for (const [k, v] of Object.entries(b.config || {})) {
            if (v === '' || v === null || v === undefined) continue;
            params[k] = v;
          }
          await rc.createRemote(name, type, params);
          const test = await testRemote(name).catch((e) => ({ ok: false, cause: e.message }));
          return sendJson(res, 200, { ok: true, name, test });
        }
        const remoteMatch = p.match(/^\/api\/remotes\/([^/]+)(?:\/(test))?$/);
        if (remoteMatch) {
          const name = decodeURIComponent(remoteMatch[1]);
          if (req.method === 'DELETE' && !remoteMatch[2]) {
            await rc.deleteRemote(name);
            delete store.data.health[name];
            store.save();
            return sendJson(res, 200, { ok: true });
          }
          if (req.method === 'POST' && remoteMatch[2] === 'test') {
            const r = await testRemote(name);
            return sendJson(res, 200, r);
          }
        }
        if (p === '/api/browse' && req.method === 'GET') {
          const remote = url.searchParams.get('remote') || '';
          const sub = url.searchParams.get('path') || '';
          // 把目录路径拼进 fs 规格里列一层（本地目录可用绝对路径从 / 浏览）
          const { list } = await rc.list(fsSpec(remote, sub), '');
          const dirs = (list || []).filter((x) => x.IsDir)
            .map((x) => ({ name: x.Name, path: (sub && sub !== '/' ? sub.replace(/\/+$/, '') + '/' : sub === '/' ? '/' : '') + x.Name }));
          return sendJson(res, 200, { dirs });
        }

        // ---------- 任务 ----------
        if (p === '/api/tasks' && req.method === 'GET') {
          return sendJson(res, 200, { tasks: store.data.tasks });
        }
        if (p === '/api/tasks' && req.method === 'POST') {
          const b = await readBody(req);
          const task = validateTask(b);
          task.id = newId();
          task.enabled = true;
          task.createdAt = new Date().toISOString();
          task.lastRunAt = null; task.lastStatus = null; task.lastSlotKey = '';
          store.data.tasks.push(task);
          store.save();
          return sendJson(res, 200, { task });
        }
        const taskMatch = p.match(/^\/api\/tasks\/([^/]+)(?:\/(run|toggle))?$/);
        if (taskMatch) {
          const id = taskMatch[1];
          const task = store.data.tasks.find((x) => x.id === id);
          if (!task) return sendJson(res, 404, { error: '任务不存在' });
          if (req.method === 'PUT' && !taskMatch[2]) {
            Object.assign(task, validateTask(await readBody(req)));
            store.save();
            return sendJson(res, 200, { task });
          }
          if (req.method === 'DELETE' && !taskMatch[2]) {
            store.data.tasks = store.data.tasks.filter((x) => x.id !== id);
            store.save();
            return sendJson(res, 200, { ok: true });
          }
          if (req.method === 'POST' && taskMatch[2] === 'toggle') {
            task.enabled = !task.enabled;
            store.save();
            return sendJson(res, 200, { task });
          }
          if (req.method === 'POST' && taskMatch[2] === 'run') {
            if (isRunning(id)) return sendJson(res, 409, { error: '这个任务正在执行中' });
            runTask(task, 'manual').catch((e) => console.error('[api] 手动执行异常：', e.message));
            return sendJson(res, 200, { started: true });
          }
        }

        // ---------- 记录 ----------
        if (p === '/api/runs' && req.method === 'GET') {
          let runs = store.data.runs;
          const taskId = url.searchParams.get('taskId');
          if (taskId) runs = runs.filter((r) => r.taskId === taskId);
          const limit = Math.min(200, Number(url.searchParams.get('limit') || 50));
          return sendJson(res, 200, { runs: runs.slice(0, limit) });
        }
        const runMatch = p.match(/^\/api\/runs\/([^/]+)\/handle$/);
        if (runMatch && req.method === 'POST') {
          const run = store.data.runs.find((r) => r.id === runMatch[1]);
          if (!run) return sendJson(res, 404, { error: '记录不存在' });
          run.handledAt = new Date().toISOString();
          store.save();
          return sendJson(res, 200, { run });
        }

        // ---------- 设置 ----------
        if (p === '/api/settings' && req.method === 'GET') {
          const s = JSON.parse(JSON.stringify(store.data.settings));
          const passSet = !!s.smtp.pass;
          s.smtp.pass = '';
          return sendJson(res, 200, { settings: s, smtpPassSet: passSet });
        }
        if (p === '/api/settings' && req.method === 'PUT') {
          const b = await readBody(req);
          const next = {
            notify: { enabled: !!b.notify?.enabled, to: String(b.notify?.to || '').trim() },
            smtp: {
              host: String(b.smtp?.host || '').trim(),
              port: Number(b.smtp?.port) || 465,
              secure: b.smtp?.secure !== false,
              user: String(b.smtp?.user || '').trim(),
              pass: String(b.smtp?.pass || '')
            }
          };
          if (!next.smtp.pass) next.smtp.pass = store.data.settings.smtp.pass; // 留空=不改
          store.data.settings = next;
          store.save();
          return sendJson(res, 200, { ok: true });
        }
        if (p === '/api/settings/test-email' && req.method === 'POST') {
          await sendTestMail();
          return sendJson(res, 200, { ok: true });
        }

        return sendJson(res, 404, { error: '接口不存在' });
      }

      // ---------- 静态前端（SPA 回退） ----------
      if (cfg.staticDir && fs.existsSync(cfg.staticDir)) {
        let file = path.join(cfg.staticDir, p === '/' ? 'index.html' : p);
        if (!file.startsWith(cfg.staticDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          file = path.join(cfg.staticDir, 'index.html');
        }
        const ext = path.extname(file);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        return res.end(fs.readFileSync(file));
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('rclona 网关运行中（开发模式：前端请用 vite dev 打开）');
    } catch (e) {
      console.error('[server]', e);
      if (!res.headersSent) sendJson(res, 500, { error: e.message || '服务器内部错误' });
      else res.end();
    }
  });
  return server;
}

function validateTask(b) {
  const name = String(b.name || '').trim();
  const srcRemote = String(b.srcRemote || '').trim();
  const dstRemote = String(b.dstRemote || '').trim();
  if (!srcRemote || !dstRemote) throw new Error('源网盘和目标网盘都要选');
  const schedType = b.schedule?.type === 'weekly' ? 'weekly' : 'daily';
  const time = /^\d{2}:\d{2}$/.test(b.schedule?.time || '') ? b.schedule.time : '03:30';
  return {
    name: name || `${srcRemote} → ${dstRemote}`,
    srcRemote,
    srcPath: String(b.srcPath || '').replace(/\/+$/, ''),
    dstRemote,
    dstPath: String(b.dstPath || '').replace(/\/+$/, ''),
    schedule: { type: schedType, time, weekday: Math.min(6, Math.max(0, Number(b.schedule?.weekday ?? 1))) }
  };
}
