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
import { classifyError } from './classify.js';
import { healthOf, testRemote } from './health.js';
import { runTask, isRunning } from './runner.js';
import { sendTestTelegram } from './notifier.js';
import { normalizeSchedule, nextSlotAfter, validateCron, validHM } from './schedule.js';
import { nextHealthCheckAt } from './scheduler.js';

const SERVER_STARTED_AT = new Date().toISOString();
let rcloneVersionCache = '';
async function rcloneVersion() {
  if (!rcloneVersionCache) {
    try { rcloneVersionCache = (await rc.version())?.version || ''; } catch { /* 拿不到就留空 */ }
  }
  return rcloneVersionCache;
}

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

// 某类型里属于「密码/密钥」的字段名集合（编辑网盘时用来脱敏与兜底剔除）
async function passwordFieldNames(type) {
  const defs = await providers().catch(() => ({}));
  const set = new Set();
  for (const o of defs[type]?.options || []) if (o.type === 'password') set.add(o.name);
  return set;
}

async function remoteList() {  const names = await rc.listRemotes();
  const out = [];
  for (const name of names) {
    let type = '';
    try { const c = await rc.getRemote(name); type = c.type || ''; } catch { /* 忽略 */ }
    out.push({ name, type, health: healthOf(name), paused: store.isPaused(name) });
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
            runs: store.data.runs.slice(0, 20),
            stats: store.data.stats,
            system: {
              rcloneVersion: await rcloneVersion(),
              startedAt: SERVER_STARTED_AT,
              nextHealthCheckAt: nextHealthCheckAt()
            }
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
        const cfgMatch = p.match(/^\/api\/remotes\/([^/]+)\/config$/);
        if (cfgMatch && (req.method === 'GET' || req.method === 'PUT')) {
          const name = decodeURIComponent(cfgMatch[1]);
          let cur = null;
          try { cur = await rc.getRemote(name); } catch { /* 不存在 */ }
          // 注意：rclone 的 config/get 对不存在的网盘返回空对象 {} 而非报错，必须看 type 判断存在性
          if (!cur || !cur.type) return sendJson(res, 404, { error: '网盘不存在' });
          const type = cur.type || '';
          const pwFields = await passwordFieldNames(type);
          if (req.method === 'GET') {
            // 密码/密钥类字段绝不回传明文（rclone 给的也是加密串）：只报告「哪些已保存」
            const config = {};
            const secrets = [];
            for (const [k, v] of Object.entries(cur)) {
              if (k === 'type') continue;
              if (pwFields.has(k)) { if (v) secrets.push(k); continue; }
              config[k] = v;
            }
            return sendJson(res, 200, { name, type, config, secrets });
          }
          // PUT 编辑保存：密码字段留空 = 不改（网关兜底剔除，不只靠前端）；其余空值同样不提交
          const b = await readBody(req);
          const params = {};
          for (const [k, v] of Object.entries(b.config || {})) {
            if (k === 'type' || v === '' || v === null || v === undefined) continue;
            params[k] = v;
          }
          if (Object.keys(params).length) await rc.updateRemote(name, params);
          const test = await testRemote(name).catch((e) => ({ ok: false, cause: e.message }));
          return sendJson(res, 200, { ok: true, name, test });
        }
        const remoteMatch = p.match(/^\/api\/remotes\/([^/]+)(?:\/(test|pause|resume))?$/);
        if (remoteMatch) {
          const name = decodeURIComponent(remoteMatch[1]);
          const action = remoteMatch[2];
          if (req.method === 'DELETE' && !action) {
            await rc.deleteRemote(name);
            delete store.data.health[name];
            delete store.data.remoteState[name];
            store.save();
            return sendJson(res, 200, { ok: true });
          }
          if (req.method === 'POST' && action === 'test') {
            const r = await testRemote(name);
            return sendJson(res, 200, r);
          }
          if (req.method === 'POST' && (action === 'pause' || action === 'resume')) {
            store.setPaused(name, action === 'pause');
            console.log(`[api] 网盘「${name}」已${action === 'pause' ? '暂停' : '恢复'}`);
            return sendJson(res, 200, { ok: true, paused: action === 'pause' });
          }
        }
        if (p === '/api/browse' && req.method === 'GET') {
          const remote = url.searchParams.get('remote') || '';
          const sub = url.searchParams.get('path') || '';
          // 把目录路径拼进 fs 规格里列一层（本地目录可用绝对路径从 / 浏览）
          let list;
          let effSub = sub;
          try {
            let spec = fsSpec(remote, sub);
            if (sub === '' || sub === '/') {
              // #21：仅浏览层特判，不动全局 fsSpec（runner 与 S3 共用它的剥尾斜杠规则）。
              // local 网盘根目录若走 fsSpec("/") 会被剥成 "名字:"，rclone local 把空路径
              // 解释为 rcd 进程的工作目录（列出来的是网关目录而非文件系统根），且随后
              // 按绝对路径点子目录（"名字:/etc"）与这个锚点对不上、报 404。
              // 故 local 根目录改发 "名字:/"，子路径仍走 fsSpec 的绝对拼接。
              let type = '';
              try { type = (await rc.getRemote(remote))?.type || ''; } catch { /* 取不到类型按原样 */ }
              if (type === 'local') { spec = `${remote}:/`; effSub = '/'; }
            }
            ({ list } = await rc.list(spec, ''));
          } catch (e) {
            // 浏览到不存在 / 打不开的路径：给一句白话提示即可，不要把 rclone 的英文报错甩给用户。
            // 注意：浏览时不自动建目录——建目录只发生在真正执行备份时（目标目录不存在会自动创建）
            // code 供前端区分处理：permission 时给「手动输入路径」兜底（见验收问题 #15）
            const kind = classifyError(e.message).kind;
            const hint = kind === 'notfound'
              ? '这个文件夹不存在（可能被改名、移动或删除了）。如果它是备份要存到的目标位置，不用管：执行备份时会自动创建。'
              : kind === 'permission'
                ? '这个网盘不允许列出这里的内容（常见于只有单个桶权限的令牌）。可以在下方手动输入路径继续。'
                : `这个文件夹暂时打不开：${classifyError(e.message).reasonZh}`;
            return sendJson(res, 400, { error: hint, code: kind });
          }
          const dirs = (list || []).filter((x) => x.IsDir)
            .map((x) => ({ name: x.Name, path: (effSub && effSub !== '/' ? effSub.replace(/\/+$/, '') + '/' : effSub === '/' ? '/' : '') + x.Name }));
          return sendJson(res, 200, { dirs });
        }

        // ---------- 任务 ----------
        if (p === '/api/tasks' && req.method === 'GET') {
          return sendJson(res, 200, { tasks: store.data.tasks });
        }
        if (p === '/api/tasks' && req.method === 'POST') {
          const b = await readBody(req);
          const task = validateTask(b);
          const now = new Date();
          task.id = newId();
          task.enabled = true;
          task.createdAt = now.toISOString();
          task.anchorAt = now.toISOString();
          const next = nextSlotAfter(task.schedule, now, task.anchorAt);
          task.nextRunAt = next ? next.toISOString() : null;
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
            const patch = validateTask(await readBody(req));
            const scheduleChanged = JSON.stringify(normalizeSchedule(patch.schedule)) !== JSON.stringify(normalizeSchedule(task.schedule));
            Object.assign(task, patch);
            if (scheduleChanged) {
              // 计划改了：从「现在」起按下一次计划时刻重新排（与新建任务同语义）
              const now = new Date();
              if (task.schedule.type === 'hours' || task.schedule.type === 'days') task.anchorAt = now.toISOString();
              const next = nextSlotAfter(task.schedule, now, task.anchorAt || task.createdAt);
              task.nextRunAt = next ? next.toISOString() : null;
            }
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
            // 重新启用时若下一次执行时间已经错过（停用期间），顺延到下一个未来时刻，不立即补跑
            if (task.enabled && task.nextRunAt && new Date(task.nextRunAt) <= new Date()) {
              const next = nextSlotAfter(task.schedule, new Date(), task.anchorAt || task.createdAt);
              task.nextRunAt = next ? next.toISOString() : null;
            }
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
          const t = store.data.settings.telegram || {};
          return sendJson(res, 200, {
            settings: { telegram: { enabled: !!t.enabled, chatId: t.chatId || '', panelAddress: t.panelAddress || '' } },
            botTokenSet: !!t.botToken
          });
        }
        if (p === '/api/settings' && req.method === 'PUT') {
          const b = await readBody(req);
          const prev = store.data.settings.telegram || {};
          const botToken = String(b.telegram?.botToken || '').trim();
          // 面板访问地址：去掉末尾斜杠后保存；填了就必须是 http(s) 网址，格式不对整单拒绝（不保存任何改动）
          const panelAddress = String(b.telegram?.panelAddress ?? prev.panelAddress ?? '').trim().replace(/\/+$/, '');
          if (panelAddress) {
            let u = null;
            try { u = new URL(panelAddress); } catch { /* 下面统一报错 */ }
            if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
              return sendJson(res, 400, { error: '面板访问地址格式不对，要像 https://panel.example.com 或 http://192.168.1.10:8080 这样填写（也可以留空不填）' });
            }
          }
          store.data.settings = {
            telegram: {
              enabled: !!b.telegram?.enabled,
              botToken: botToken || prev.botToken || '', // 留空 = 不改已保存的令牌
              chatId: String(b.telegram?.chatId || '').trim(),
              panelAddress
            }
          };
          store.save();
          return sendJson(res, 200, { ok: true });
        }
        if (p === '/api/settings/test-telegram' && req.method === 'POST') {
          await sendTestTelegram();
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
        // 缓存策略（#22）：入口 HTML（根路径与 SPA 回退）一律 no-cache，每次用前向服务器校验，
        // 避免发新版后浏览器还拿着旧 index.html 连带旧 bundle；/assets/ 下是 vite 带内容哈希的
        // 产物（文件名变即内容变），可放心长缓存 immutable；其余静态文件同样 no-cache
        // （目前 dist 里没有这类独立文件，favicon 是入口页内联的 data URI）。
        const cacheControl = path.basename(file) !== 'index.html' && p.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
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
  const raw = b.schedule || {};
  const schedule = normalizeSchedule(raw);
  if (schedule.type === 'cron') {
    if (!schedule.cron) throw new Error('选择了 cron 方式，就要填 cron 表达式');
    try { validateCron(schedule.cron); }
    catch (e) { throw new Error(`cron 表达式有问题：${e.message}`); }
  }
  if (raw.time !== undefined && raw.time !== '' && !/^\d{2}:\d{2}$/.test(raw.time)) {
    throw new Error('执行时间格式不对（例如 03:30）');
  }
  if (schedule.time) schedule.time = validHM(schedule.time);
  return {
    name: name || `${srcRemote} → ${dstRemote}`,
    srcRemote,
    srcPath: String(b.srcPath || '').replace(/\/+$/, ''),
    dstRemote,
    dstPath: String(b.dstPath || '').replace(/\/+$/, ''),
    schedule
  };
}
