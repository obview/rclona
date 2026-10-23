// #27：任务级高级选项（A 段：旧版本保留 / 删除安全阀 / 限速 / 改名识别；
// B 段：备份加密开关 crypt）的归一化。
// 两处共用：server.js 的 validateTask（收用户输入，非法值抛中文错误）与
// runner.js 运行时读取（老任务没有这些字段——一律给「与从前完全一致」的默认值：
// 不保留旧版、安全阀不限、不限速、不认改名，绝不因为升级改变老任务行为）。

const intOr = (v, fallback) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// rclone 限速写法：数字（字节/秒）或带单位后缀，如 500k、5M、1.5G（可再带 B，如 5MB）
export const BWLIMIT_RE = /^\d+(\.\d+)?\s*[kKmMgGtT]?[bB]?$/;

export function defaultTaskOptions() {
  return {
    versioning: { enabled: false, keepDays: 30 },
    maxDelete: { count: 0, percent: 0 }, // 任一为 0 = 该维度不限
    bwlimit: '',
    trackRenames: false,
    // #27 B 段：备份加密开关（仅开关；密码是全局设置，不进任务，见 crypt.js）
    crypt: { enabled: false }
  };
}

// 运行时读取：对存储里的任务（可能是老数据/缺字段）宽容取值，永不抛错
export function taskOptionsOf(task) {
  const d = defaultTaskOptions();
  const v = task?.versioning && typeof task.versioning === 'object' ? task.versioning : {};
  const m = task?.maxDelete && typeof task.maxDelete === 'object' ? task.maxDelete : {};
  return {
    versioning: {
      enabled: !!v.enabled,
      keepDays: clamp(intOr(v.keepDays, d.versioning.keepDays), 1, 3650)
    },
    maxDelete: {
      count: clamp(intOr(m.count, 0), 0, 100000000),
      percent: clamp(intOr(m.percent, 0), 0, 100)
    },
    bwlimit: typeof task?.bwlimit === 'string' && BWLIMIT_RE.test(task.bwlimit.trim()) ? task.bwlimit.trim() : '',
    trackRenames: !!task?.trackRenames,
    crypt: { enabled: !!(task?.crypt && typeof task.crypt === 'object' && task.crypt.enabled) }
  };
}

// 保存时校验：输入非法就抛中文错误（给 validateTask 用）
export function normalizeTaskOptionsInput(b) {
  const out = defaultTaskOptions();
  if (b.versioning !== undefined && b.versioning !== null) {
    if (typeof b.versioning !== 'object' || Array.isArray(b.versioning)) throw new Error('旧版本保留的设置格式不对');
    out.versioning.enabled = !!b.versioning.enabled;
    const kd = intOr(b.versioning.keepDays, 30);
    if (kd < 1 || kd > 3650) throw new Error('旧版本保留天数要在 1 到 3650 之间');
    out.versioning.keepDays = kd;
  }
  if (b.maxDelete !== undefined && b.maxDelete !== null) {
    if (typeof b.maxDelete !== 'object' || Array.isArray(b.maxDelete)) throw new Error('删除安全阀的设置格式不对');
    const count = intOr(b.maxDelete.count, 0);
    const percent = intOr(b.maxDelete.percent, 0);
    if (count < 0 || count > 100000000) throw new Error('安全阀的删除文件数上限要在 0（不限）到 100000000 之间');
    if (percent < 0 || percent > 100) throw new Error('安全阀的删除比例要在 0（不限）到 100 之间');
    out.maxDelete = { count, percent };
  }
  if (b.bwlimit !== undefined && b.bwlimit !== null) {
    const s = String(b.bwlimit).trim();
    if (s && !BWLIMIT_RE.test(s)) throw new Error('限速格式不对：填数字加单位，如 500k（≈500 KB/秒）、5M（≈5 MB/秒）；留空表示不限速');
    out.bwlimit = s;
  }
  if (b.trackRenames !== undefined) out.trackRenames = !!b.trackRenames;
  if (b.crypt !== undefined && b.crypt !== null) {
    if (typeof b.crypt !== 'object' || Array.isArray(b.crypt)) throw new Error('备份加密的设置格式不对');
    out.crypt.enabled = !!b.crypt.enabled;
  }
  return out;
}
