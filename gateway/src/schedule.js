// 备份计划：六种类型（每天 / 每周多选 / 每月 / 每隔 N 小时 / 每隔 N 天 / cron）
// 归一化后的形状：
// { type, time:'HH:MM', weekdays:[0..6], dayOfMonth:1..31,
//   intervalHours:n, intervalDays:n, cron:'分 时 日 月 周' }
// 「锚点 anchor」是任务上单独存的 anchorAt（一般为创建时间）：
// 每隔 N 小时以锚点为原点推算，每隔 N 天以锚点日期为第 0 天。

const DAY_MS = 86400000;

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
// 计划的人话写法（与前端 util.scheduleText 同口径），供通知等服务端场景使用
export function scheduleText(s) {
  if (!s) return '未设置计划';
  switch (s.type) {
    case 'weekly': {
      const days = (s.weekdays && s.weekdays.length ? s.weekdays : [s.weekday ?? 1])
        .map((d) => WEEKDAYS_ZH[d]).filter(Boolean).join('、');
      return `每${days} ${s.time}`;
    }
    case 'monthly':
      return `每月 ${s.dayOfMonth} 号 ${s.time}`;
    case 'hours':
      return `每 ${s.intervalHours} 小时`;
    case 'days':
      return `每 ${s.intervalDays} 天 ${s.time}`;
    case 'cron':
      return `cron：${s.cron}`;
    default:
      return `每天 ${s.time}`;
  }
}

export function validHM(s, fallback = '03:30') {
  return /^\d{2}:\d{2}$/.test(s || '') && Number(s.slice(0, 2)) <= 23 && Number(s.slice(3, 5)) <= 59 ? s : fallback;
}
function parseHM(s) {
  const [h, m] = validHM(s).split(':').map(Number);
  return { h, m };
}
function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function normalizeSchedule(raw) {
  const s = raw || {};
  const time = validHM(s.time);
  switch (s.type) {
    case 'weekly': {
      let days = Array.isArray(s.weekdays) ? s.weekdays : (s.weekday != null ? [s.weekday] : [1]);
      days = [...new Set(days.map((d) => clampInt(d, 0, 6, 1)))].sort((a, b) => a - b);
      return { type: 'weekly', time, weekdays: days.length ? days : [1] };
    }
    case 'monthly':
      return { type: 'monthly', time, dayOfMonth: clampInt(s.dayOfMonth, 1, 31, 1) };
    case 'hours':
      return { type: 'hours', intervalHours: clampInt(s.intervalHours, 1, 720, 6) };
    case 'days':
      return { type: 'days', time, intervalDays: clampInt(s.intervalDays, 1, 365, 3) };
    case 'cron':
      return { type: 'cron', cron: String(s.cron || '').trim() };
    default:
      return { type: 'daily', time };
  }
}

// ---------- cron（标准五段：分 时 日 月 周；支持 * 、列表、区间、步长） ----------
function parseCronField(text, min, max, label) {
  const set = new Set();
  for (const part of String(text).split(',')) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) throw new Error(`cron ${label}部分写错了：「${part}」`);
    const step = m[3] ? Number(m[3]) : 1;
    if (step < 1) throw new Error(`cron ${label}的步长要大于 0`);
    let lo, hi;
    if (m[1] === '*') { lo = min; hi = max; }
    else { lo = Number(m[1]); hi = m[2] != null ? Number(m[2]) : (m[3] ? max : lo); }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron ${label}超出范围（${min}–${max}）`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, isStar: String(text).trim() === '*' };
}

export function parseCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron 表达式要是五段：分 时 日 月 周，例如「30 3 * * *」');
  const minute = parseCronField(f[0], 0, 59, '分钟');
  const hour = parseCronField(f[1], 0, 23, '小时');
  const dom = parseCronField(f[2], 1, 31, '日期');
  const month = parseCronField(f[3], 1, 12, '月份');
  const dowRaw = parseCronField(f[4], 0, 7, '星期');
  const dow = { set: new Set([...dowRaw.set].map((d) => d % 7)), isStar: dowRaw.isStar }; // 0 与 7 都是周日
  return { minute, hour, dom, month, dow };
}
export function validateCron(expr) { parseCron(expr); return true; }

function cronMatches(p, d) {
  if (!p.minute.set.has(d.getMinutes()) || !p.hour.set.has(d.getHours()) || !p.month.set.has(d.getMonth() + 1)) return false;
  const domHit = p.dom.set.has(d.getDate());
  const dowHit = p.dow.set.has(d.getDay());
  if (p.dom.isStar && p.dow.isStar) return true;
  if (p.dom.isStar) return dowHit;
  if (p.dow.isStar) return domHit;
  return domHit || dowHit; // 标准 cron：日期与星期都限定时任一命中即可
}

function atTime(base, h, m) {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

// 下一个「严格晚于 after」的计划时刻；找不到返回 null
export function nextSlotAfter(sched, after, anchor) {
  const s = normalizeSchedule(sched);
  const t = after instanceof Date ? after : new Date(after);
  const anc = anchor ? new Date(anchor) : t;
  switch (s.type) {
    case 'daily': {
      const { h, m } = parseHM(s.time);
      let c = atTime(t, h, m);
      if (c <= t) { c = new Date(c); c.setDate(c.getDate() + 1); }
      return c;
    }
    case 'weekly': {
      const { h, m } = parseHM(s.time);
      for (let add = 0; add <= 7; add++) {
        const c = atTime(t, h, m);
        c.setDate(c.getDate() + add);
        if (c > t && s.weekdays.includes(c.getDay())) return c;
      }
      return null;
    }
    case 'monthly': {
      const { h, m } = parseHM(s.time);
      for (let add = 0; add <= 14; add++) {
        const base = new Date(t.getFullYear(), t.getMonth() + add, 1);
        const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
        const c = new Date(base.getFullYear(), base.getMonth(), Math.min(s.dayOfMonth, lastDay), h, m, 0, 0);
        if (c > t) return c;
      }
      return null;
    }
    case 'hours': {
      const step = s.intervalHours * 3600000;
      const k = Math.max(1, Math.floor((t - anc) / step) + 1);
      return new Date(anc.getTime() + k * step);
    }
    case 'days': {
      const { h, m } = parseHM(s.time);
      const base = atTime(anc, h, m); // 锚点当天的计划时刻是第 0 个槽
      let k = Math.max(0, Math.floor((t - base) / (s.intervalDays * DAY_MS)));
      let c = new Date(base); c.setDate(c.getDate() + k * s.intervalDays);
      while (c <= t) { k++; c = new Date(base); c.setDate(c.getDate() + k * s.intervalDays); }
      return c;
    }
    case 'cron': {
      let p;
      try { p = parseCron(s.cron); } catch { return null; }
      const c = new Date(t); c.setSeconds(0, 0); c.setMinutes(c.getMinutes() + 1);
      const limit = 366 * 24 * 60;
      for (let i = 0; i < limit; i++) {
        if (cronMatches(p, c)) return new Date(c);
        c.setMinutes(c.getMinutes() + 1);
      }
      return null;
    }
    default: return null;
  }
}

// 最近一个「不晚于 t」的计划时刻（用于判断停机期间是否错过）；没有返回 null
export function lastSlotAtOrBefore(sched, t0, anchor) {
  const s = normalizeSchedule(sched);
  const t = t0 instanceof Date ? t0 : new Date(t0);
  const anc = anchor ? new Date(anchor) : t;
  switch (s.type) {
    case 'daily': {
      const { h, m } = parseHM(s.time);
      let c = atTime(t, h, m);
      if (c > t) { c = new Date(c); c.setDate(c.getDate() - 1); }
      return c;
    }
    case 'weekly': {
      const { h, m } = parseHM(s.time);
      for (let sub = 0; sub <= 7; sub++) {
        const c = atTime(t, h, m);
        c.setDate(c.getDate() - sub);
        if (c <= t && s.weekdays.includes(c.getDay())) return c;
      }
      return null;
    }
    case 'monthly': {
      const { h, m } = parseHM(s.time);
      for (let sub = 0; sub <= 14; sub++) {
        const base = new Date(t.getFullYear(), t.getMonth() - sub, 1);
        const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
        const c = new Date(base.getFullYear(), base.getMonth(), Math.min(s.dayOfMonth, lastDay), h, m, 0, 0);
        if (c <= t) return c;
      }
      return null;
    }
    case 'hours': {
      const step = s.intervalHours * 3600000;
      const k = Math.floor((t - anc) / step);
      return k >= 1 ? new Date(anc.getTime() + k * step) : null;
    }
    case 'days': {
      const { h, m } = parseHM(s.time);
      const base = atTime(anc, h, m);
      if (t < base) return null;
      let k = Math.floor((t - base) / (s.intervalDays * DAY_MS));
      let c = new Date(base); c.setDate(c.getDate() + k * s.intervalDays);
      while (c > t) { k--; c = new Date(base); c.setDate(c.getDate() + k * s.intervalDays); }
      return c;
    }
    case 'cron': {
      let p;
      try { p = parseCron(s.cron); } catch { return null; }
      const c = new Date(t); c.setSeconds(0, 0);
      const limit = 366 * 24 * 60;
      for (let i = 0; i < limit; i++) {
        if (cronMatches(p, c)) return new Date(c);
        c.setMinutes(c.getMinutes() - 1);
      }
      return null;
    }
    default: return null;
  }
}

// 任务首次（或老数据迁移时）计算 nextRunAt：
// 若「上次运行之后、本应执行的时刻」已经错过（停机造成），返回 now 表示启动后补跑一次；
// 否则返回下一个未来时刻。
export function initialNextRunAt(task, now = new Date()) {
  const sched = normalizeSchedule(task.schedule);
  const anchor = task.anchorAt || task.createdAt || now;
  const missed = lastSlotAtOrBefore(sched, now, anchor);
  const ref = task.lastRunAt ? new Date(task.lastRunAt).getTime()
    : (task.createdAt ? new Date(task.createdAt).getTime() : 0);
  if (missed && missed.getTime() > ref) return new Date(now);
  return nextSlotAfter(sched, now, anchor);
}
