import { store } from './store.js';
import { runTask, isRunning } from './runner.js';
import { dailyCheckAll, testRemote, healthOf } from './health.js';
import { nextSlotAfter, initialNextRunAt, normalizeSchedule } from './schedule.js';
import { cfg } from './config.js';

// 轻量调度：每 tickMs 巡检一次「到点的备份任务」「每日网盘自检」「失效网盘复测」
// 备份任务以任务上持久化的 nextRunAt 为准：
// - 新建任务在创建时算好（创建后的下一个计划时刻，绝不立即补跑）
// - 服务停机期间错过的：nextRunAt 落在过去，重启后到点即触发一次，随即按「现在」重算下一个 —— 只补一次
function parseHM(s) {
  const [h, m] = String(s || '03:00').split(':').map((x) => parseInt(x, 10));
  return { h: h || 0, m: m || 0 };
}
function dateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 下一次每日网盘自检的时间（给首页系统信息卡展示）
export function nextHealthCheckAt(now = new Date()) {
  const { h, m } = parseHM(cfg.healthDailyTime);
  const today = new Date(now); today.setHours(h, m, 0, 0);
  if (store.data.healthMeta.lastDailyDate === dateKey(now) || now >= today) {
    if (store.data.healthMeta.lastDailyDate === dateKey(now)) {
      const tmr = new Date(today); tmr.setDate(tmr.getDate() + 1);
      return tmr.toISOString();
    }
    return today.toISOString(); // 今天还没跑（马上会在下一个 tick 跑）
  }
  return today.toISOString();
}

async function tick() {
  const now = new Date();
  // 备份任务
  for (const task of store.data.tasks) {
    if (!task.enabled || isRunning(task.id)) continue;
    if (!task.nextRunAt) {
      // 老数据/异常数据兜底：按「停机补跑一次」语义初始化
      const init = initialNextRunAt(task, now);
      task.nextRunAt = init ? init.toISOString() : null;
      store.save();
      if (!task.nextRunAt) continue;
    }
    if (new Date(task.nextRunAt) <= now) {
      // 先把下一次算好再触发：本次无论成败（含暂停跳过），都不会重复触发同一个时刻
      const anchor = task.anchorAt || task.createdAt || now;
      const next = nextSlotAfter(normalizeSchedule(task.schedule), now, anchor);
      task.nextRunAt = next ? next.toISOString() : null;
      store.save();
      console.log(`[scheduler] 定时触发备份任务「${task.name}」`);
      runTask(task, 'schedule').catch((e) => console.error('[scheduler] 任务异常：', e.message));
    }
  }
  // 每日网盘自检：当天设定时刻后跑一次（天然排在大多数备份任务之前，错峰不强耦合）
  const { h, m } = parseHM(cfg.healthDailyTime);
  const daily = new Date(now); daily.setHours(h, m, 0, 0);
  const today = dateKey(now);
  if (now >= daily && store.data.healthMeta.lastDailyDate !== today) {
    store.data.healthMeta.lastDailyDate = today;
    store.save();
    console.log('[scheduler] 执行每日网盘连通自检');
    dailyCheckAll().catch(() => {});
  }
  // 异常/失效网盘复测（down 状态低频复测，恢复自动解除；已暂停的在 testRemote 里跳过）
  for (const [name, health] of Object.entries(store.data.health)) {
    if ((health.status === 'retrying' || health.status === 'down') && health.nextCheckAt && new Date(health.nextCheckAt) <= now) {
      testRemote(name, { fromSchedule: true }).catch(() => {});
    }
  }
}

export function startScheduler() {
  setInterval(() => { tick().catch((e) => console.error('[scheduler]', e.message)); }, cfg.tickMs);
  tick().catch(() => {});
  console.log(`[scheduler] 已启动（巡检间隔 ${cfg.tickMs / 1000}s，自检时间 ${cfg.healthDailyTime}）`);
}
export { healthOf };
