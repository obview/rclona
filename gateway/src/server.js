import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { store, newId, pairsOf } from './store.js';
import {
  account, needsSetup, checkCredentials, setPassword,
  createSession, sessionUser, dropSession, parseCookies,
  SESSION_COOKIE, sessionCookieHeader, clearCookieHeader,
  loginLocked, noteLoginFail, noteLoginOk
} from './auth.js';
import { rc, normalizeProviders, fsSpec, spawnCat } from './rc.js';
import { cryptPasswordSet, setCryptPassword, clearCryptPassword } from './crypt.js';
import { classifyError } from './classify.js';
import { healthOf, testRemote, checkCapacity } from './health.js';
import { runTask, isRunning, previewTask } from './runner.js';
import { sendTestTelegram } from './notifier.js';
import { normalizeSchedule, nextSlotAfter, validateCron, validHM } from './schedule.js';
import { normalizePairFilters } from './filters.js';
import { normalizeTaskOptionsInput, normalizeSyncModeInput } from './taskopts.js';
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
    out.push({ name, type, health: healthOf(name), paused: store.isPaused(name), needsCredentials: store.needsCredentials(name) });
  }
  return out;
}

const REMOTE_NAME_RE = /^[A-Za-z0-9_.\-]+$/;

// #31：网盘详情聚合——全部用既有数据拼（rclone 配置 / store 里的健康、任务、运行记录），不新增存储。
// 关系口径：任务的 srcRemote/dstRemote 是任务级字段，pairs 只存路径——本网盘是 srcRemote →
// 「同步给」dstRemote；是 dstRemote → 「被同步自」srcRemote（多组映射逐组各算一条）。
async function remoteDetail(name) {
  const names = await rc.listRemotes();
  if (!names.includes(name)) return null;
  let type = '';
  try { const c = await rc.getRemote(name); type = c.type || ''; } catch { /* 忽略 */ }
  const rs = (store.data.remoteState || {})[name] || {};
  const rel = [];
  for (const t of store.data.tasks || []) {
    for (const pr of pairsOf(t)) {
      if (t.srcRemote === name) rel.push({ dir: 'src', task: t, otherRemote: t.dstRemote || '', otherPath: pr.dst || '' });
      else if (t.dstRemote === name) rel.push({ dir: 'dst', task: t, otherRemote: t.srcRemote || '', otherPath: pr.src || '' });
    }
  }
  const relIds = new Set(rel.map((x) => x.task.id));
  const lastByTask = {};
  for (const r of store.data.runs || []) {
    if (relIds.has(r.taskId) && !lastByTask[r.taskId]) lastByTask[r.taskId] = r; // runs 新→旧序，第一条即最近
  }
  const brief = (x) => {
    const lr = lastByTask[x.task.id];
    return {
      id: x.task.id, name: x.task.name, otherRemote: x.otherRemote, otherPath: x.otherPath,
      schedule: x.task.schedule || null, enabled: x.task.enabled !== false, mode: x.task.mode || 'mirror',
      lastStatus: lr?.status || null, lastRunAt: lr?.startedAt || null
    };
  };
  const taskNameById = new Map((store.data.tasks || []).map((t) => [t.id, t.name]));
  return {
    name, type,
    paused: store.isPaused(name),
    needsCredentials: store.needsCredentials(name),
    createdAt: rs.createdAt || null,
    health: healthOf(name),
    tasksAsSrc: rel.filter((x) => x.dir === 'src').map(brief),
    tasksAsDst: rel.filter((x) => x.dir === 'dst').map(brief),
    recentRuns: (store.data.runs || []).filter((r) => relIds.has(r.taskId)).slice(0, 10)
      .map((r) => ({
        id: r.id, taskId: r.taskId, taskName: taskNameById.get(r.taskId) || '（任务已删除）',
        startedAt: r.startedAt, status: r.status,
        stats: r.stats ? { files: r.stats.files ?? null, bytes: r.stats.bytes ?? null } : null
      }))
  };
}

// 列某个网盘某个目录的一层条目（目录与文件原样返回），文件夹选择器、文件浏览、下载共用。
// #21 的本地根目录特判只发生在这里，不动全局 fsSpec（runner 与 S3 共用它的剥尾斜杠规则）：
// local 网盘根目录若走 fsSpec("/") 会被剥成 "名字:"，rclone local 会把空路径解释为 rcd 进程
// 的工作目录（列出网关目录而非文件系统根）；故 local 根目录改发 "名字:/"，子路径仍走 fsSpec。
async function listDirEntries(remote, sub) {
  let spec = fsSpec(remote, sub);
  let effSub = sub;
  if (sub === '' || sub === '/') {
    let type = '';
    try { type = (await rc.getRemote(remote))?.type || ''; } catch { /* 取不到类型按原样 */ }
    if (type === 'local') { spec = `${remote}:/`; effSub = '/'; }
  }
  const { list } = await rc.list(spec, '');
  return { list: list || [], effSub };
}
// 容量提醒阈值的规范值（0–100 的整数，0 = 关闭）；存储里的脏数据在这里兜底
function capacityThreshold() {
  const n = Number(store.data.settings.capacity?.alertPercent ?? 90);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.trunc(n))) : 90;
}
// 条目在网盘内的完整路径（与 FolderPicker 的路径拼接同一口径）
function entryFullPath(effSub, name) {
  return (effSub && effSub !== '/' ? effSub.replace(/\/+$/, '') + '/' : effSub === '/' ? '/' : '') + name;
}
// 浏览类接口打不开路径时的白话提示（浏览时不自动建目录——建目录只发生在真正执行备份时）
function browseErrorBody(e) {
  const kind = classifyError(e.message).kind;
  const hint = kind === 'notfound'
    ? '这个文件夹不存在（可能被改名、移动或删除了）。如果它是备份要存到的目标位置，不用管：执行备份时会自动创建。'
    : kind === 'permission'
      ? '这个网盘不允许列出这里的内容（常见于只有单个桶权限的令牌）。可以在下方手动输入路径继续。'
      : `这个文件夹暂时打不开：${classifyError(e.message).reasonZh}`;
  return { error: hint, code: kind };
}

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
          // #31：记下创建时间，详情页要显示（老网盘没有这个字段，详情页显示「—」）
          if (!store.data.remoteState) store.data.remoteState = {};
          store.data.remoteState[name] = { ...(store.data.remoteState[name] || {}), createdAt: new Date().toISOString() };
          store.save();
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
          // #27 B 段：用户在这里补存过配置，导入留下的「待补填凭证」标记就此清除
          if (store.needsCredentials(name)) store.setNeedsCredentials(name, false);
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
        // #31：网盘详情聚合（只读拼装：基本信息 + 健康/容量 + 关系任务 + 最近运行）
        const detailMatch = p.match(/^\/api\/remotes\/([^/]+)\/detail$/);
        if (detailMatch && req.method === 'GET') {
          const d = await remoteDetail(decodeURIComponent(detailMatch[1]));
          if (!d) return sendJson(res, 404, { error: '网盘不存在' });
          return sendJson(res, 200, d);
        }
        // #31「立即刷新」：当场实测一次连接状态 + 容量（走既有 testRemote / checkCapacity 通道，不加轮询），再回最新详情
        if (detailMatch && req.method === 'POST') {
          const name = decodeURIComponent(detailMatch[1]);
          const names = await rc.listRemotes();
          if (!names.includes(name)) return sendJson(res, 404, { error: '网盘不存在' });
          await testRemote(name).catch(() => null);
          await checkCapacity(name).catch(() => null);
          return sendJson(res, 200, await remoteDetail(name));
        }
        if (p === '/api/browse' && req.method === 'GET') {
          const remote = url.searchParams.get('remote') || '';
          const sub = url.searchParams.get('path') || '';
          // 把目录路径拼进 fs 规格里列一层（本地目录可用绝对路径从 / 浏览）；
          // code 供前端区分处理：permission 时给「手动输入路径」兜底（见验收问题 #15）
          let list, effSub;
          try {
            ({ list, effSub } = await listDirEntries(remote, sub));
          } catch (e) {
            return sendJson(res, 400, browseErrorBody(e));
          }
          const dirs = list.filter((x) => x.IsDir)
            .map((x) => ({ name: x.Name, path: entryFullPath(effSub, x.Name) }));
          return sendJson(res, 200, { dirs });
        }

        // #27 B 段：文件浏览——与 /api/browse 同一浏览层，但目录和文件都返回（文件带大小/类型）
        if (p === '/api/files' && req.method === 'GET') {
          const remote = url.searchParams.get('remote') || '';
          const sub = url.searchParams.get('path') || '';
          let list, effSub;
          try {
            ({ list, effSub } = await listDirEntries(remote, sub));
          } catch (e) {
            return sendJson(res, 400, browseErrorBody(e));
          }
          const dirs = list.filter((x) => x.IsDir)
            .map((x) => ({ name: x.Name, path: entryFullPath(effSub, x.Name) }));
          const files = list.filter((x) => !x.IsDir)
            .map((x) => ({
              name: x.Name, path: entryFullPath(effSub, x.Name),
              size: typeof x.Size === 'number' ? x.Size : null, mime: x.MimeType || ''
            }));
          return sendJson(res, 200, { dirs, files });
        }

        // #27 B 段：从面板取回单个文件——流式下载。
        // 先经浏览层在父目录里确认条目存在且是文件（顺便拿到大小/类型），再用 rclone cat
        // 子进程把内容直接管道到响应：全程流式，网关不把文件读进内存；登录保护由上面的统一鉴权把守。
        if (p === '/api/download' && req.method === 'GET') {
          const remote = url.searchParams.get('remote') || '';
          const filePath = (url.searchParams.get('path') || '').replace(/\/+$/, '');
          if (!remote || !filePath) return sendJson(res, 400, { error: '没说清要下载哪个网盘里的哪个文件' });
          const idx = filePath.lastIndexOf('/');
          const parent = idx > 0 ? filePath.slice(0, idx) : idx === 0 ? '/' : '';
          let entry = null;
          try {
            const found = await listDirEntries(remote, parent);
            entry = found.list.find((x) => entryFullPath(found.effSub, x.Name) === filePath) || null;
          } catch (e) {
            return sendJson(res, 400, browseErrorBody(e));
          }
          if (!entry) return sendJson(res, 404, { error: '这个文件不存在（可能被改名、移动或删除了）' });
          if (entry.IsDir) return sendJson(res, 400, { error: '这是一个文件夹，不能直接下载；请点进去，选里面的文件下载' });
          const headers = {
            'Content-Type': entry.MimeType || 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.Name)}`
          };
          if (typeof entry.Size === 'number' && entry.Size >= 0) headers['Content-Length'] = String(entry.Size);
          const child = spawnCat(fsSpec(remote, filePath));
          let stderr = '';
          child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
          res.on('close', () => { try { child.kill('SIGTERM'); } catch { /* 进程已结束 */ } });
          child.stdout.once('data', (chunk) => {
            // 读到第一个字节才发响应头：读之前就失败（如中途被删）还能回一句人话错误
            if (!res.headersSent) { res.writeHead(200, headers); res.write(chunk); child.stdout.pipe(res); }
          });
          child.on('close', (code) => {
            if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
            if (code === 0) { res.writeHead(200, headers); res.end(); } // 0 字节文件：无数据也算成功
            else sendJson(res, 500, { error: `下载失败：${classifyError(stderr).reasonZh}` });
          });
          child.on('error', (e) => {
            if (!res.headersSent) sendJson(res, 500, { error: `下载失败：${e.message}` });
          });
          return;
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
        const taskMatch = p.match(/^\/api\/tasks\/([^/]+)(?:\/(run|toggle|preview|duplicate))?$/);
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
          if (req.method === 'POST' && taskMatch[2] === 'duplicate') {
            // #27 B 段：任务复制——配置（映射/计划/高级选项）全量照抄，运行态清零，
            // 且副本先置为停用：不会自动跑，用户检查过、手动启用后才开始定时。
            const now = new Date();
            const copy = JSON.parse(JSON.stringify(task));
            copy.id = newId();
            copy.name = `${task.name}（副本）`;
            copy.enabled = false;
            copy.createdAt = now.toISOString();
            copy.anchorAt = now.toISOString();
            copy.nextRunAt = null;
            copy.lastRunAt = null;
            copy.lastStatus = null;
            copy.lastSlotKey = '';
            copy.firstSuccessNotified = false;
            store.data.tasks.push(copy);
            store.save();
            return sendJson(res, 200, { task: copy });
          }
          if (req.method === 'POST' && taskMatch[2] === 'preview') {
            // #27 试运行：只比对不动数据（不落记录、不发通知），任务正在跑时先拒绝，避免清单是半成品状态
            if (isRunning(id)) return sendJson(res, 409, { error: '这个任务正在执行中，等它跑完再试运行' });
            const preview = await previewTask(task);
            return sendJson(res, 200, { preview });
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
            settings: {
              telegram: { enabled: !!t.enabled, chatId: t.chatId || '', panelAddress: t.panelAddress || '' },
              capacity: { alertPercent: capacityThreshold() }
            },
            botTokenSet: !!t.botToken,
            // 备份加密密码同令牌口径：只报「设没设」，永不下发明文（库里存的也是混淆串）
            cryptPasswordSet: cryptPasswordSet()
          });
        }
        if (p === '/api/settings' && req.method === 'PUT') {
          const b = await readBody(req);
          const prev = store.data.settings;
          // 分段保存：请求里带哪段就改哪段，没带的段原样保留（各卡片可以单独保存）
          const next = {
            telegram: { ...(prev.telegram || {}) },
            backupCrypt: { ...(prev.backupCrypt || { password: '' }) },
            capacity: { ...(prev.capacity || { alertPercent: 90 }) }
          };
          if (b.telegram !== undefined) {
            const pt = prev.telegram || {};
            const botToken = String(b.telegram?.botToken || '').trim();
            // 面板访问地址：去掉末尾斜杠后保存；填了就必须是 http(s) 网址，格式不对整单拒绝（不保存任何改动）
            const panelAddress = String(b.telegram?.panelAddress ?? pt.panelAddress ?? '').trim().replace(/\/+$/, '');
            if (panelAddress) {
              let u = null;
              try { u = new URL(panelAddress); } catch { /* 下面统一报错 */ }
              if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
                return sendJson(res, 400, { error: '面板访问地址格式不对，要像 https://panel.example.com 或 http://192.168.1.10:8080 这样填写（也可以留空不填）' });
              }
            }
            next.telegram = {
              enabled: !!b.telegram?.enabled,
              botToken: botToken || pt.botToken || '', // 留空 = 不改已保存的令牌
              chatId: String(b.telegram?.chatId || '').trim(),
              panelAddress
            };
          }
          if (b.capacity !== undefined) {
            const pct = Number(b.capacity?.alertPercent);
            if (!Number.isFinite(pct) || Math.trunc(pct) !== pct || pct < 0 || pct > 100) {
              return sendJson(res, 400, { error: '容量提醒阈值要填 0 到 100 之间的整数（单位是百分比）；填 0 表示关闭容量提醒' });
            }
            next.capacity.alertPercent = pct;
          }
          store.data.settings = next;
          store.save();
          // 备份加密密码：要设就先混淆再入库（明文只在内存过手）；清除是单独的明确动作
          try {
            if (b.clearCryptPassword) clearCryptPassword();
            else if (String(b.backupCryptPassword || '').trim()) await setCryptPassword(String(b.backupCryptPassword));
          } catch (e) {
            return sendJson(res, 400, { error: e.message });
          }
          return sendJson(res, 200, { ok: true });
        }
        if (p === '/api/settings/test-telegram' && req.method === 'POST') {
          await sendTestTelegram();
          return sendJson(res, 200, { ok: true });
        }

        // #27 B 段：配置导出——任务 + 设置（非敏感项）+ 网盘（非敏感字段）。
        // 红线：网盘密码/密钥、Telegram 令牌、备份加密密码、面板登录信息一律不进文件；
        // 网盘只记下「哪些密码字段原本有值」（secrets 名单），导入后凭名单提示逐个补填。
        // #33：配置导出 = 完整备份（sun 明确要求导入后完全还原、不再逐个补填）：
        // 网盘全部字段（含密钥，rclone 保存形态）、Telegram 全部设置（含令牌）、备份加密密码
        // （服务端保存形态）、面板登录的盐+哈希（非明文密码）、任务与设置全量都在里面。
        // 这是用户在自己面板里主动下载的文件；网关日志/测试里绝不打印其内容。
        if (p === '/api/settings/export' && req.method === 'GET') {
          const s = store.data.settings;
          const remotes = [];
          for (const name of await rc.listRemotes()) {
            let cur = null;
            try { cur = await rc.getRemote(name); } catch { /* 读不到的网盘跳过 */ }
            if (!cur || !cur.type) continue;
            const config = {};
            for (const [k, v] of Object.entries(cur)) {
              if (k === 'type') continue;
              config[k] = v; // 含密码类字段：值是 rclone 的保存形态，导入端原样写回即可用
            }
            const rs = (store.data.remoteState || {})[name] || {};
            remotes.push({ name, type: cur.type, config, paused: !!rs.paused, createdAt: rs.createdAt || null });
          }
          const doc = {
            app: 'rclona', kind: 'config-export', version: 2,
            exportedAt: new Date().toISOString(),
            note: '警告：这个文件里有你全部网盘的登录密钥、Telegram 机器人令牌和备份加密密码，等于你所有网盘的钥匙。只许存在你自己的设备上，不要发给任何人、不要通过聊天软件传输、不要上传到公开网盘。导入后可以完整还原，不需要再补填任何密码。',
            settings: {
              telegram: {
                enabled: !!s.telegram?.enabled, chatId: s.telegram?.chatId || '',
                panelAddress: s.telegram?.panelAddress || '', botToken: s.telegram?.botToken || ''
              },
              capacity: { alertPercent: capacityThreshold() },
              backupCrypt: { password: s.backupCrypt?.password || '' }
            },
            auth: store.data.auth
              ? { user: store.data.auth.user, salt: store.data.auth.salt, hash: store.data.auth.hash }
              : null,
            remotes,
            tasks: store.data.tasks.map((t) => ({
              name: t.name, srcRemote: t.srcRemote, dstRemote: t.dstRemote,
              pairs: pairsOf(t), schedule: t.schedule, mode: t.mode || 'mirror',
              versioning: t.versioning, maxDelete: t.maxDelete,
              bwlimit: t.bwlimit, trackRenames: t.trackRenames, crypt: t.crypt,
              enabled: !!t.enabled
            }))
          };
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="rclona-backup-${new Date().toISOString().slice(0, 10)}.json"`
          });
          return res.end(JSON.stringify(doc, null, 2));
        }

        // #33：配置导入 = 还原。版本 2（完整备份）：同名网盘/任务以文件为准覆盖、新的补入，
        // 任务的启用状态与定时按文件恢复，Telegram/加密密码/登录校验一并还原，不再要补填任何东西；
        // 版本 1（旧的去密钥导出）仍可导入：同名网盘只更新非密钥字段（已有密钥不被空值冲掉）、
        // 新网盘缺密钥的照旧打「待补填凭证」标记、同名任务跳过、新任务先停用——并在报告里
        // 用 missingSecrets 点名哪些是旧格式缺密钥的。
        if (p === '/api/settings/import' && req.method === 'POST') {
          const b = await readBody(req);
          const doc = b?.data ?? b;
          if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
            return sendJson(res, 400, { error: '导入失败：这不是 rclona 的配置导出文件（请选择用面板「导出配置」下载的那个 JSON 文件）' });
          }
          if (doc.app !== 'rclona') return sendJson(res, 400, { error: '导入失败：这不是 rclona 的配置导出文件' });
          if (doc.version !== 1 && doc.version !== 2) {
            return sendJson(res, 400, { error: `导入失败：这个导出文件的版本（${doc.version ?? '未知'}）暂时不支持，只支持版本 1 和 2` });
          }
          const full = doc.version === 2;
          const rep = {
            remotesAdded: [], remotesReplaced: [], remotesUpdated: [], remotesSkipped: [],
            tasksAdded: [], tasksReplaced: [], tasksSkipped: [],
            missingSecrets: [], authRestored: false, errors: []
          };
          if (doc.settings && typeof doc.settings === 'object') {
            const s = store.data.settings;
            if (doc.settings.telegram) {
              const tg = doc.settings.telegram;
              s.telegram = {
                ...(s.telegram || {}),
                enabled: !!tg.enabled,
                chatId: String(tg.chatId || ''),
                panelAddress: String(tg.panelAddress || '').replace(/\/+$/, '')
              };
              // 令牌只在完整备份（v2）里有：有才覆盖；v1 文件没有这个字段，本机令牌保持不动
              if (full && typeof tg.botToken === 'string') s.telegram.botToken = tg.botToken;
            }
            if (doc.settings.capacity && Number.isFinite(Number(doc.settings.capacity.alertPercent))) {
              const pct = Math.trunc(Number(doc.settings.capacity.alertPercent));
              if (pct >= 0 && pct <= 100) s.capacity = { alertPercent: pct };
            }
            // 备份加密密码（服务端保存形态）只在 v2 里有，非空才还原
            if (full && typeof doc.settings.backupCrypt?.password === 'string' && doc.settings.backupCrypt.password) {
              if (!s.backupCrypt) s.backupCrypt = { password: '' };
              s.backupCrypt.password = doc.settings.backupCrypt.password;
            }
          }
          // 面板登录校验（盐+哈希，非明文）：只在 v2 里有，还原后原账号密码直接能登录
          if (full && doc.auth && typeof doc.auth === 'object' && doc.auth.salt && doc.auth.hash) {
            store.data.auth = { user: String(doc.auth.user || ''), salt: String(doc.auth.salt), hash: String(doc.auth.hash) };
            rep.authRestored = true;
          }
          const existingRemotes = await rc.listRemotes().catch(() => []);
          for (const r of Array.isArray(doc.remotes) ? doc.remotes : []) {
            const name = String(r?.name || '').trim();
            const type = String(r?.type || '').trim();
            if (!REMOTE_NAME_RE.test(name) || !type) { rep.errors.push(`有一个网盘条目名字或类型不对，已跳过（名字：${name || '（空）'}）`); continue; }
            const exists = existingRemotes.includes(name);
            const pwFields = await passwordFieldNames(type);
            if (full) {
              // 完整备份：全部字段原样写回（含密钥）。同名 = 先删后建地整体替换；
              // 万一重建失败，用导入前读到的旧配置兜底恢复，避免「删了又没建上」
              const params = {};
              for (const [k, v] of Object.entries(r?.config || {})) {
                if (k === 'type' || v === '' || v === null || v === undefined) continue;
                params[k] = v;
              }
              let oldCfg = null;
              if (exists) { try { oldCfg = await rc.getRemote(name); } catch { /* 读不到就无兜底 */ } }
              try {
                if (exists) await rc.deleteRemote(name);
                await rc.createRemote(name, type, params);
                if (!exists) existingRemotes.push(name);
                delete store.data.health[name]; // 旧健康状态作废，等下一次自检重新测
                if (!store.data.remoteState) store.data.remoteState = {};
                store.data.remoteState[name] = {
                  ...(store.data.remoteState[name] || {}),
                  createdAt: r.createdAt || store.data.remoteState[name]?.createdAt || new Date().toISOString()
                };
                if (typeof r.paused === 'boolean') store.setPaused(name, r.paused);
                store.setNeedsCredentials(name, false);
                (exists ? rep.remotesReplaced : rep.remotesAdded).push(name);
              } catch (e) {
                if (exists && oldCfg?.type) {
                  const back = {};
                  for (const [k, v] of Object.entries(oldCfg)) if (k !== 'type') back[k] = v;
                  await rc.createRemote(name, oldCfg.type, back).catch(() => {});
                  rep.errors.push(`网盘「${name}」替换失败，已恢复成导入前的配置：${e.message}`);
                } else {
                  rep.errors.push(`网盘「${name}」导入失败：${e.message}`);
                }
              }
              continue;
            }
            // —— v1 旧格式（去密钥）：密码类字段一律不碰 ——
            if (exists) {
              // 同名：只更新非密钥字段，已存的密钥原样保留，绝不被空值冲掉
              const params = {};
              for (const [k, v] of Object.entries(r?.config || {})) {
                if (k === 'type' || pwFields.has(k) || v === '' || v === null || v === undefined) continue;
                params[k] = v;
              }
              try {
                if (Object.keys(params).length) await rc.updateRemote(name, params);
                rep.remotesUpdated.push(name);
                if (Array.isArray(r.secrets) && r.secrets.length) rep.missingSecrets.push(name);
              } catch (e) { rep.errors.push(`网盘「${name}」更新失败：${e.message}`); }
              continue;
            }
            const params = {};
            for (const [k, v] of Object.entries(r?.config || {})) {
              if (k === 'type' || pwFields.has(k) || v === '' || v === null || v === undefined) continue;
              params[k] = v;
            }
            try {
              await rc.createRemote(name, type, params);
              existingRemotes.push(name);
              if (!store.data.remoteState) store.data.remoteState = {};
              store.data.remoteState[name] = { ...(store.data.remoteState[name] || {}), createdAt: new Date().toISOString() };
              rep.remotesAdded.push(name);
              if (Array.isArray(r.secrets) && r.secrets.length) {
                store.setNeedsCredentials(name, true);
                rep.missingSecrets.push(name);
              }
            } catch (e) { rep.errors.push(`网盘「${name}」导入失败：${e.message}`); }
          }
          const taskByName = new Map(store.data.tasks.map((t) => [t.name, t]));
          for (const rt of Array.isArray(doc.tasks) ? doc.tasks : []) {
            const name = String(rt?.name || '').trim();
            if (!name) { rep.errors.push('有一个任务条目没有名字，已跳过'); continue; }
            const existingTask = taskByName.get(name);
            if (existingTask && !full) { rep.tasksSkipped.push(name); continue; }
            try {
              const task = validateTask(rt);
              const now = new Date();
              if (existingTask) {
                // v2 同名任务：以文件为准整体替换，但保留 id/创建时间/运行历史关联；
                // 启用状态与下次运行时间按文件恢复（scheduler 按 anchor 重算，与编辑任务同一口径）
                const keep = {
                  id: existingTask.id, createdAt: existingTask.createdAt, anchorAt: existingTask.anchorAt || now.toISOString(),
                  lastRunAt: existingTask.lastRunAt, lastStatus: existingTask.lastStatus,
                  lastSlotKey: existingTask.lastSlotKey, firstSuccessNotified: existingTask.firstSuccessNotified
                };
                Object.assign(existingTask, task, keep);
                existingTask.enabled = !!rt.enabled;
                const next = existingTask.enabled ? nextSlotAfter(existingTask.schedule, now, existingTask.anchorAt) : null;
                existingTask.nextRunAt = next ? next.toISOString() : null;
                rep.tasksReplaced.push(name);
              } else {
                task.id = newId();
                // v2 按文件恢复启用状态；v1 一律先停用（凭证可能还没补，人工检查后再启用）
                task.enabled = full ? !!rt.enabled : false;
                task.createdAt = now.toISOString();
                task.anchorAt = now.toISOString();
                const next = task.enabled ? nextSlotAfter(task.schedule, now, task.anchorAt) : null;
                task.nextRunAt = next ? next.toISOString() : null;
                task.lastRunAt = null; task.lastStatus = null; task.lastSlotKey = '';
                task.firstSuccessNotified = false;
                store.data.tasks.push(task);
                taskByName.set(task.name, task);
                rep.tasksAdded.push(task.name);
              }
            } catch (e) { rep.errors.push(`任务「${name}」导入失败：${e.message}`); }
          }
          store.save();
          return sendJson(res, 200, { ok: true, report: rep });
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
  // #25：文件夹映射列表。优先用 pairs（多组）；兼容只传单组 srcPath/dstPath 的老客户端。
  // 路径为空字符串表示网盘根目录，是合法选择；但一组都不能没有。
  let rawPairs;
  if (b.pairs !== undefined) {
    if (!Array.isArray(b.pairs) || !b.pairs.length) throw new Error('至少要有一组文件夹映射（源文件夹 → 目标文件夹）');
    rawPairs = b.pairs;
  } else {
    rawPairs = [{ src: b.srcPath, dst: b.dstPath }];
  }
  const cleanPath = (v) => String(v ?? '').replace(/\/+$/, '');
  const pairs = rawPairs.map((p, i) => ({
    src: cleanPath(p?.src),
    dst: cleanPath(p?.dst),
    filters: normalizePairFilters(p?.filters, i + 1)
  }));
  pairs.forEach((p, i) => {
    if (srcRemote === dstRemote && p.src === p.dst) {
      throw new Error(`第 ${i + 1} 组的源和目标是同一个位置，换一个目标文件夹`);
    }
  });
  // #27：任务级高级选项（旧版本保留/删除安全阀/限速/改名识别/备份加密）；老客户端不传 = 全默认（行为不变）
  const options = normalizeTaskOptionsInput(b);
  // #30：同步方式（mirror/copy/bisync）；不传 = mirror。双向同步与筛选已实测可组合、与加密
  // 同为「目标走 crypt 视图」，均不拦；它与旧版本保留/安全阀/改名识别不适用，由界面隐藏、
  // runner 忽略，不在这里报错（用户切换模式时不该被卡住）。
  const mode = normalizeSyncModeInput(b);
  // 备份加密要用到全局的加密密码：没设密码就开启加密，任务跑起来必然失败，这里先拦下并说清去哪设
  if (options.crypt.enabled && !cryptPasswordSet()) {
    throw new Error('这个任务开启了备份加密，但你还没设置「备份加密密码」：请先到「设置」页填好密码再回来开启（密码丢失 = 加密的备份全部无法恢复，务必记牢）');
  }
  return {
    name: name || `${srcRemote} → ${dstRemote}`,
    srcRemote,
    srcPath: pairs[0].src, // 镜像：第一组（概览等老展示读它）
    dstRemote,
    dstPath: pairs[0].dst,
    pairs,
    schedule,
    mode,
    versioning: options.versioning,
    maxDelete: options.maxDelete,
    bwlimit: options.bwlimit,
    trackRenames: options.trackRenames,
    crypt: options.crypt
  };
}
