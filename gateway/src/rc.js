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
  // 删除整个目录（连同内容），#27 归档过期清理用
  purge: (fs, remote = '') => call('operations/purge', { fs, remote }, 120000),
  about: (fs) => call('operations/about', { fs }, 30000),
  // 全局带宽限速的读/设（#27 限速）：rc 的 _config 里 BwLimit 在 1.75.2 实测不生效，
  // 只有 core/bwlimit 这个全局开关真能限住（同步开始前设、结束后恢复原值）
  bwlimitGet: () => call('core/bwlimit', {}, 15000),
  bwlimitSet: (rate) => call('core/bwlimit', { rate }, 15000),
  // filterRules：带 + / - 前缀的完整 rclone FilterRule（如 ['- proc/**', '+ *.zip', '- **']），
  // 经 rc 的 _filter.FilterRule 传入，顺序就是规则生效顺序（v1.75.2 实测字段名无误）。
  check: (srcFs, dstFs, filterRules) => call('operations/check', {
    srcFs, dstFs,
    ...(filterRules?.length ? { _filter: { FilterRule: filterRules } } : {})
  }, 15 * 60 * 1000),
  // configOpts：rclone 的单次调用级配置（_config），#27 用到的键已在 1.75.2 实测：
  // BackupDir（旧版本归档目录）、TrackRenames（改名识别）、DryRun（试运行）均真实生效；
  // BwLimit 在 _config 里不生效（见上方 bwlimitSet 的注释），不要往这里塞。
  syncAsync: async (srcFs, dstFs, filterRules, configOpts) => (await call('sync/sync', {
    srcFs, dstFs, _async: true,
    ...(filterRules?.length ? { _filter: { FilterRule: filterRules } } : {}),
    ...(configOpts && Object.keys(configOpts).length ? { _config: configOpts } : {})
  })).jobid,
  jobStatus: (jobid) => call('job/status', { jobid }, 15000),
  stats: (group) => call('core/stats', { group }, 15000)
};

// ---------- 一次性 rclone 子进程（不经常驻内存，用完即走） ----------
// 密码混淆：rclone obscure 把明文密码转成可存进配置的串（crypt 密码入库前过这一步，库里永不存明文）
export function obscureValue(plain) {
  return new Promise((resolve, reject) => {
    const p = spawn(cfg.rcloneBin, ['obscure', String(plain)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(`无法运行 rclone：${e.message}`)));
    p.on('close', (code) => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`密码处理失败：${err.trim() || `rclone 退出码 ${code}`}`));
    });
  });
}
// 流式取文件：rclone cat 把文件内容写到 stdout，调用方直接把 stdout 管道到 HTTP 响应——
// 全程不把文件读进内存（#27 面板下载）。用与 rcd 相同的配置文件，支持包括 crypt 在内的所有 remote。
export function spawnCat(spec) {
  const confPath = path.join(cfg.dataDir, 'rclone.conf');
  return spawn(cfg.rcloneBin, ['cat', `--config=${confPath}`, spec], { stdio: ['ignore', 'pipe', 'pipe'] });
}

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
