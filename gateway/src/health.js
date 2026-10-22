import { store } from './store.js';
import { rc, fsSpec } from './rc.js';
import { classifyError } from './classify.js';
import { sendRemoteDownMail } from './mailer.js';
import { cfg } from './config.js';

// 网盘连通自检状态机：
// ok --失败--> retrying（每 healthRetryMs 复测）--连败达阈值--> down（发邮件）
// 任意一次成功 --> ok（down 自动解除）
function blankHealth() {
  return {
    status: 'unknown', failCount: 0, lastCheckAt: null, lastOkAt: null,
    cause: '', downSince: null, notifiedDown: false, nextCheckAt: null
  };
}
export function healthOf(name) {
  if (!store.data.health[name]) store.data.health[name] = blankHealth();
  return store.data.health[name];
}

const inFlight = new Set(); // 防重入：同一网盘的检测不能并发（慢网盘会把调用堆死）

export async function testRemote(name, { fromSchedule = false } = {}) {
  if (inFlight.has(name)) return { ok: false, skipped: true, cause: healthOf(name).cause };
  inFlight.add(name);
  const h = healthOf(name);
  h.lastCheckAt = new Date().toISOString();
  h.nextCheckAt = new Date(Date.now() + cfg.healthRetryMs * 2).toISOString(); // 先占位，结果出来再覆盖
  try {
    await rc.list(fsSpec(name, ''), '');
    const wasDown = h.status === 'down';
    h.status = 'ok';
    h.failCount = 0;
    h.cause = '';
    h.downSince = null;
    h.notifiedDown = false;
    h.nextCheckAt = null;
    h.lastOkAt = h.lastCheckAt;
    store.save();
    if (wasDown) console.log(`[health] 网盘「${name}」已恢复连接`);
    return { ok: true };
  } catch (e) {
    const { reasonZh } = classifyError(e.message);
    h.cause = reasonZh;
    h.failCount += 1;
    if (h.failCount >= cfg.healthFailThreshold) {
      const newlyDown = h.status !== 'down';
      h.status = 'down';
      if (!h.downSince) h.downSince = h.lastCheckAt;
      // 失效后仍低频复测（间隔 12 倍），恢复了能自动解除
      h.nextCheckAt = new Date(Date.now() + cfg.healthRetryMs * 12).toISOString();
      store.save();
      if (newlyDown && !h.notifiedDown) {
        h.notifiedDown = true;
        store.save();
        sendRemoteDownMail(name, reasonZh).catch(() => {});
      }
      console.log(`[health] 网盘「${name}」判定连接失效：${reasonZh}`);
    } else {
      h.status = 'retrying';
      h.nextCheckAt = new Date(Date.now() + cfg.healthRetryMs).toISOString();
      store.save();
      console.log(`[health] 网盘「${name}」第 ${h.failCount} 次检查失败（${fromSchedule ? '定时' : '手动'}）：${reasonZh}`);
    }
    return { ok: false, cause: reasonZh };
  } finally {
    inFlight.delete(name);
  }
}

// 每日全量自检（所有网盘各测一次；失败的进入复测节奏）
export async function dailyCheckAll() {
  const names = await rc.listRemotes().catch(() => []);
  for (const name of names) {
    await testRemote(name, { fromSchedule: true }).catch(() => {});
  }
  return names;
}
