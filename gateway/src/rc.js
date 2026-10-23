import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

// rclone 以 rcd 模式常驻：全局带 --checksum（纯镜像 + 校验和是本产品的固定策略）
let child = null;
const BASE = () => `http://${cfg.rcAddr}`;

export function fsSpec(remote, p = '') {
  // 路径原样拼接：网盘类是相对路径（bucket/dir），本地目录是绝对路径（/data/x）
  const clean = String(p || '').replace(/\/+$/, '');
  return clean ? `${remote}:${clean}` : `${remote}:`;
}

export async function call(method, params = {}, timeoutMs = 60000) {
  let res;
  try {
    res = await fetch(`${BASE()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    throw new Error(`无法连接 rclone 服务：${e.message}`);
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const msg = data?.error || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function startRcd() {
  const confPath = path.join(cfg.dataDir, 'rclone.conf');
  if (!fs.existsSync(confPath)) fs.writeFileSync(confPath, '');
  const logPath = path.join(cfg.dataDir, 'rclone.log');
  child = spawn(cfg.rcloneBin, [
    'rcd',
    `--rc-addr=${cfg.rcAddr}`,
    '--rc-no-auth',
    `--config=${confPath}`,
    '--checksum',
    `--log-file=${logPath}`,
    '--log-level=NOTICE'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write(`[rclone] ${d}`));
  child.on('exit', (code) => {
    console.error(`[rclone] rcd 进程退出（code=${code}），5 秒后重启`);
    setTimeout(() => startRcd().catch(() => {}), 5000);
  });
  // 等待就绪
  const deadline = Date.now() + 30000;
  for (;;) {
    try { await call('core/version', {}, 2000); return; }
    catch {
      if (Date.now() > deadline) throw new Error('rclone rcd 启动超时');
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
export function stopRcd() { if (child) { child.removeAllListeners('exit'); child.kill('SIGTERM'); child = null; } }

// ---------- 常用 rc 操作 ----------
export const rc = {
  version: () => call('core/version'),
  listRemotes: async () => (await call('config/listremotes')).remotes || [],
  getRemote: (name) => call('config/get', { name }),
  createRemote: (name, type, parameters) => call('config/create', { name, type, parameters }),
  // 只更新给出的字段，未提及的字段（含已存的密码）原样保留（v1.75.2 实测）
  updateRemote: (name, parameters) => call('config/update', { name, parameters }),
  deleteRemote: (name) => call('config/delete', { name }),
  providers: () => call('config/providers'),
  // 列一层目录（真实读取，可用于连通性测试）
  list: (fs, remote = '') => call('operations/list', { fs, remote }, 45000),
  // 递归列出全部条目（#18 占位对象检测用；opt.recurse 是 operations/list 的选项，v1.75.2 实测可用）
  listAll: (fs) => call('operations/list', { fs, remote: '', opt: { recurse: true } }, 120000),
  // 创建目录（连同上级目录一并创建），备份执行时用来自动补建不存在的目标目录
  mkdir: (fs, remote = '') => call('operations/mkdir', { fs, remote }, 45000),
  about: (fs) => call('operations/about', { fs }, 30000),
  // excludeRules：相对源根目录的排除规则（如 ['proc/**']），经 rc 的 _filter 传入
  // （rclone v1.75 实测：_filter 的字段名是 ExcludeRule，不是 Exclude）
  check: (srcFs, dstFs, excludeRules) => call('operations/check', {
    srcFs, dstFs,
    ...(excludeRules?.length ? { _filter: { ExcludeRule: excludeRules } } : {})
  }, 15 * 60 * 1000),
  syncAsync: async (srcFs, dstFs, excludeRules) => (await call('sync/sync', {
    srcFs, dstFs, _async: true,
    ...(excludeRules?.length ? { _filter: { ExcludeRule: excludeRules } } : {})
  })).jobid,
  jobStatus: (jobid) => call('job/status', { jobid }, 15000),
  stats: (group) => call('core/stats', { group }, 15000)
};

// 把 rc 的 provider 定义压成前端表单需要的形状
export function normalizeProviders(raw) {
  const out = {};
  for (const p of raw.providers || []) {
    out[p.Name] = {
      description: p.Description || '',
      options: (p.Options || [])
        .filter((o) => ((o.Hide | 0) & 2) === 0)
        .map((o) => ({
          name: o.Name,
          help: String(o.Help || '').split('\n')[0],
          type: o.IsPassword ? 'password' : (o.Type || 'string'),
          default: o.DefaultStr ?? (o.Default == null ? '' : String(o.Default)),
          required: !!o.Required,
          advanced: !!o.Advanced,
          provider: o.Provider || '',
          examples: (o.Examples || []).map((e) => ({ value: String(e.Value), help: e.Help || '' }))
        }))
    };
  }
  return out;
}
