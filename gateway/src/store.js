import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeSchedule } from './schedule.js';
import { normalizePairFilters } from './filters.js';
import { taskOptionsOf } from './taskopts.js';

// 极简的 JSON 持久化：数据量很小（任务、记录、设置），整存整取 + 原子写
const FILE = 'rclona.json';

export function newId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// #25：一个任务可有多组文件夹映射 pairs[{src, dst}]（源/目标网盘与定时仍是任务级）。
// 老任务只有单组字段 srcPath/dstPath —— 统一在这里换算成 pairs；
// 任务上同时保留 srcPath/dstPath 作为 pairs[0] 的镜像，概览等老代码读它们不受影响。
export function pairsOf(t) {
  const clean = (v) => String(v ?? '').replace(/\/+$/, '');
  const cleanFilters = (filters) => {
    try { return normalizePairFilters(filters); } catch { return []; }
  };
  if (Array.isArray(t?.pairs) && t.pairs.length) {
    return t.pairs.map((p) => ({ src: clean(p?.src), dst: clean(p?.dst), filters: cleanFilters(p?.filters) }));
  }
  return [{ src: clean(t?.srcPath), dst: clean(t?.dstPath), filters: [] }];
}

const DEFAULT_STATS = () => ({
  runs: 0, success: 0, failed: 0, // 累计完成备份次数（成功+失败，跳过不计）
  bytes: 0, files: 0, // 累计传输量 / 文件数
  lastRunFiles: null, lastRunBytes: null // 最近一次成功备份的传输文件数 / 字节数
});

const DEFAULTS = () => ({
  auth: null, // {user, salt, hash} —— 首次启动由环境变量或设置向导生成
  settings: {
    telegram: { enabled: false, botToken: '', chatId: '', panelAddress: '' },
    // #27 B 段：备份加密密码只存 rclone obscure 之后的串（不是明文）；UI 只报已设/未设
    backupCrypt: { password: '' },
    // #27 B 段：网盘容量提醒阈值（已用百分比，0 = 关闭提醒）
    capacity: { alertPercent: 90 }
  },
  tasks: [],
  runs: [],
  health: {}, // remote 名 -> 自检状态
  healthMeta: { lastDailyDate: '' },
  remoteState: {}, // remote 名 -> { paused }（网盘暂停状态，只存网关侧）
  stats: DEFAULT_STATS()
});

export const store = {
  data: DEFAULTS(),
  dir: '',
  load(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FILE);
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.data = { ...DEFAULTS(), ...parsed };
        // 设置：只保留现行结构（老版本的邮箱/SMTP 设置直接丢弃，改用 Telegram）
        this.data.settings = {
          telegram: { ...DEFAULTS().settings.telegram, ...(parsed.settings?.telegram || {}) },
          backupCrypt: { ...DEFAULTS().settings.backupCrypt, ...(parsed.settings?.backupCrypt || {}) },
          capacity: { ...DEFAULTS().settings.capacity, ...(parsed.settings?.capacity || {}) }
        };
        this.data.remoteState = parsed.remoteState || {};
        // 任务：计划结构归一化（老结构 weekly 的单选 weekday → weekdays 数组等），补锚点
        for (const t of this.data.tasks || []) {
          t.schedule = normalizeSchedule(t.schedule);
          if (!t.anchorAt) t.anchorAt = t.createdAt || new Date().toISOString();
          // #25：单组老任务自动迁移为 pairs；srcPath/dstPath 同步为第一组镜像（线上真任务原样等价）
          t.pairs = pairsOf(t);
          t.srcPath = t.pairs[0].src;
          t.dstPath = t.pairs[0].dst;
          // #27：任务级高级选项补齐为规范形（老任务缺字段 = 全默认，行为与从前完全一致）
          const o = taskOptionsOf(t);
          t.versioning = o.versioning;
          t.maxDelete = o.maxDelete;
          t.bwlimit = o.bwlimit;
          t.trackRenames = o.trackRenames;
          t.crypt = o.crypt;
        }
        // 累计计数：老数据没有就从已有运行记录里播种一次
        if (parsed.stats) {
          this.data.stats = { ...DEFAULT_STATS(), ...parsed.stats };
        } else {
          const st = DEFAULT_STATS();
          const runs = [...(this.data.runs || [])].reverse(); // 从旧到新
          for (const r of runs) {
            if (r.status === 'success' || r.status === 'failed') {
              st.runs++;
              if (r.status === 'success') {
                st.success++;
                st.bytes += r.stats?.bytes || 0;
                st.files += r.stats?.transferred || 0;
                st.lastRunFiles = r.stats?.transferred ?? 0;
                st.lastRunBytes = r.stats?.bytes ?? 0;
              } else {
                st.failed++;
                // 与 bumpStats 同口径：失败记录里已传的部分也入账
                st.bytes += r.stats?.bytes || 0;
                st.files += r.stats?.transferred || 0;
              }
            }
          }
          this.data.stats = st;
        }
      } catch (e) {
        console.error('[store] 记录文件损坏，已重置：', e.message);
        this.data = DEFAULTS();
      }
    }
  },
  save() {
    const file = path.join(this.dir, FILE);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, file);
  },
  addRun(run) {
    this.data.runs.unshift(run);
    if (this.data.runs.length > 500) this.data.runs.length = 500;
    this.save();
  },
  updateRun(id, patch) {
    const r = this.data.runs.find((x) => x.id === id);
    if (r) { Object.assign(r, patch); this.save(); }
    return r;
  },
  // 一次备份完成（成功/失败）后累计计数；跳过不调用
  bumpStats(run) {
    const st = this.data.stats;
    st.runs++;
    if (run.status === 'success') {
      st.success++;
      st.bytes += run.stats?.bytes || 0;
      st.files += run.stats?.transferred || 0;
      st.lastRunFiles = run.stats?.transferred ?? 0;
      st.lastRunBytes = run.stats?.bytes ?? 0;
    } else if (run.status === 'failed') {
      st.failed++;
      // #18：失败前已传出的部分也如实入账（以前一律记 0，与目标端实际收到的对不上）
      st.bytes += run.stats?.bytes || 0;
      st.files += run.stats?.transferred || 0;
    }
    this.save();
  },
  // #27 B 段：导入配置时凭据被剥掉的网盘打「待补填」标记，用户在编辑里补存后清除
  needsCredentials(name) {
    return !!this.data.remoteState?.[name]?.needsCredentials;
  },
  setNeedsCredentials(name, flag) {
    if (!this.data.remoteState) this.data.remoteState = {};
    this.data.remoteState[name] = { ...(this.data.remoteState[name] || {}), needsCredentials: !!flag };
    this.save();
  },
  isPaused(name) {
    return !!this.data.remoteState?.[name]?.paused;
  },
  setPaused(name, paused) {
    if (!this.data.remoteState) this.data.remoteState = {};
    this.data.remoteState[name] = { ...(this.data.remoteState[name] || {}), paused: !!paused };
    this.save();
  }
};
