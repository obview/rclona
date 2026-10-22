import { store } from './store.js';
import { runTask, isRunning } from './runner.js';
import { dailyCheckAll, testRemote, healthOf } from './health.js';
import { cfg } from './config.js';

// 轻量调度：每 tickMs 巡检一次「到点的备份任务」「每日网盘自检」「失效网盘复测」
function parseHM(s) {
  const [h, m] = String(s || '03:00').split(':').map((x) => parseInt(x, 10));
  return { h: h || 0, m: m || 0 };
}
function dateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 返回「当前已到点、最近一个计划时刻」的 { key, at }；还没到点返回 null
function slotDue(task, now) {
  const { time, type, weekday } = task.schedule || {};
  const { h, m } = parseHM(time);
  const slot = new Date(now); slot.setHours(h, m, 0, 0);
  if (type === 'weekly') {
    // 本周内最近一个命中的执行日
    const diff = (now.getDay() - Number(weekday) + 7) % 7;
    slot.setDate(slot.getDate() - diff);
  }
  if (now < slot) return null;
  return { key: `${dateKey(slot)} ${time}`, at: slot };
}

async function tick() {
  const now = new Date();
  // 备份任务
  for (const task of store.data.tasks) {
    if (!task.enabled || isRunning(task.id)) continue;
    const due = slotDue(task, now);
    if (due && task.lastSlotKey !== due.key) {
      task.lastSlotKey = due.key;
      store.save();
      // 补跑只针对「服务停机期间错过」的已存在任务：slot 早于任务创建时间的不跑，
      // 新建任务从创建后的下一个计划时刻起执行（slot 已登记，明天/下周到点会正常触发）
      const createdAt = task.createdAt ? new Date(task.createdAt).getTime() : 0;
      if (due.at.getTime() < createdAt) continue;
      console.log(`[scheduler] 定时触发备份任务「${task.name}」`);
      runTask(task, 'schedule').catch((e) => console.error('[scheduler] 任务异常：', e.message));
    }
  }
  // 每日网盘自检：当天 03:00 后跑一次（天然排在大多数备份任务之前，错峰不强耦合）
  const { h, m } = parseHM(cfg.healthDailyTime);
  const daily = new Date(now); daily.setHours(h, m, 0, 0);
  const today = dateKey(now);
  if (now >= daily && store.data.healthMeta.lastDailyDate !== today) {
    store.data.healthMeta.lastDailyDate = today;
    store.save();
    console.log('[scheduler] 执行每日网盘连通自检');
    dailyCheckAll().catch(() => {});
  }
  // 异常/失效网盘复测（down 状态低频复测，恢复自动解除）
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
