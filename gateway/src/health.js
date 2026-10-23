import { store } from './store.js';
import { rc, fsSpec } from './rc.js';
import { classifyError } from './classify.js';
import { notifyRemoteDown, notifyRemoteRecovered, notifyCapacityAlert } from './notifier.js';
import { cfg } from './config.js';

// 网盘连通自检状态机：
// ok --失败--> retrying（每 healthRetryMs 复测）--连败达阈值--> down（发 Telegram 通知）
// 任意一次成功 --> ok（down 自动解除，解除时也发一条恢复通知）
// 已暂停的网盘不参加定时自检（手动测试不受影响）
function blankHealth() {
  return {
    status: 'unknown', failCount: 0, lastCheckAt: null, lastOkAt: null,
    cause: '', remark: '', downSince: null, notifiedDown: false, nextCheckAt: null,
    // #27 B 段：容量快照（about 拿不到的网盘为 null）；capacityAlerted 是防重复提醒的锁存
    about: null, usedPercent: null, capacityAlerted: false
  };
}
export function healthOf(name) {
  if (!store.data.health[name]) store.data.health[name] = blankHealth();
  return store.data.health[name];
}

const inFlight = new Set(); // 防重入：同一网盘的检测不能并发（慢网盘会把调用堆死）

// S3 单桶令牌的根目录探测必然被拒：列全部桶（ListBuckets）返回 AccessDenied(403)，
// 这是最小权限令牌的预期行为、不是连接失败（真凭证错误是 InvalidAccessKeyId 等，见 classify）。
const SINGLE_BUCKET_REMARK = '令牌为单桶权限，无法列出全部桶，属正常';
async function isSingleBucketDenial(name, err) {
  const msg = String(err?.message || '');
  if (!/accessdenied|access denied/i.test(msg)) return false;
  if (/invalidaccesskeyid|signaturedoesnotmatch|invalidclienttokenid/i.test(msg)) return false;
  try { return ((await rc.getRemote(name))?.type || '') === 's3'; } catch { return false; }
}

export async function testRemote(name, { fromSchedule = false } = {}) {
  // 已暂停：定时自检直接跳过，不改动状态、不发通知；手动测试照常执行
  if (fromSchedule && store.isPaused(name)) return { ok: false, skipped: true, paused: true, cause: '网盘已暂停' };
  if (inFlight.has(name)) return { ok: false, skipped: true, cause: healthOf(name).cause };
  inFlight.add(name);
  const h = healthOf(name);
  h.lastCheckAt = new Date().toISOString();
  h.nextCheckAt = new Date(Date.now() + cfg.healthRetryMs * 2).toISOString(); // 先占位，结果出来再覆盖
  try {
    let listErr = null;
    try { await rc.list(fsSpec(name, ''), ''); } catch (e) { listErr = e; }
    // S3 根目录列举被拒但属于单桶令牌的正常现象 → 按连通处理，并附一句说明
    const singleBucket = listErr ? await isSingleBucketDenial(name, listErr) : false;
    if (listErr && !singleBucket) throw listErr;
    const wasDown = h.status === 'down';
    h.status = 'ok';
    h.failCount = 0;
    h.cause = '';
    h.remark = singleBucket ? SINGLE_BUCKET_REMARK : '';
    h.downSince = null;
    h.notifiedDown = false;
    h.nextCheckAt = null;
    h.lastOkAt = h.lastCheckAt;
    store.save();
    if (wasDown) {
      console.log(`[health] 网盘「${name}」已恢复连接`);
      notifyRemoteRecovered(name).catch(() => {});
    }
    return singleBucket ? { ok: true, remark: h.remark } : { ok: true };
  } catch (e) {
    const { reasonZh } = classifyError(e.message);
    h.cause = reasonZh;
    h.remark = '';
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
        notifyRemoteDown(name, reasonZh).catch(() => {});
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

// #27 B 段：容量巡检——搭每日自检的车，顺带问一次 rclone about（总量/已用/剩余），
// 结果存进健康记录供网盘卡片展示；使用率超过设置里的阈值就发 Telegram 提醒。
// 防轰炸口径：同一网盘「超限」只报一次（capacityAlerted 锁存），使用率回到阈值以下
// 才重置锁存、下次再超限才会再报。about 拿不到（网盘不支持/单桶令牌列不了根目录等）
// 就把快照记为 null，界面显示「未知」，不报错、不提醒。
export async function checkCapacity(name) {
  const h = healthOf(name);
  let about = null;
  try {
    const ab = await rc.about(fsSpec(name, ''));
    if (ab && typeof ab.total === 'number' && ab.total > 0) {
      about = {
        total: ab.total,
        used: typeof ab.used === 'number' ? ab.used : null,
        free: typeof ab.free === 'number' ? ab.free : null,
        objects: typeof ab.objects === 'number' ? ab.objects : null,
        checkedAt: new Date().toISOString()
      };
    }
  } catch { /* 拿不到容量不是故障 */ }
  h.about = about;
  h.usedPercent = about && typeof about.used === 'number'
    ? Math.round((about.used / about.total) * 1000) / 10
    : null;
  const thresholdRaw = Number(store.data.settings.capacity?.alertPercent ?? 90);
  const threshold = Number.isFinite(thresholdRaw) ? Math.min(100, Math.max(0, Math.trunc(thresholdRaw))) : 90;
  if (h.usedPercent != null && threshold > 0) {
    if (h.usedPercent >= threshold && !h.capacityAlerted) {
      h.capacityAlerted = true;
      store.save();
      console.log(`[health] 网盘「${name}」容量告警：已用 ${h.usedPercent}%（阈值 ${threshold}%）`);
      notifyCapacityAlert(name, h.usedPercent, about, threshold).catch(() => {});
    } else if (h.usedPercent < threshold && h.capacityAlerted) {
      h.capacityAlerted = false; // 回落到阈值以下：重置，下次超限可再报
    }
  } else if (h.capacityAlerted && (h.usedPercent == null || threshold === 0)) {
    h.capacityAlerted = false; // 查不到容量或提醒被关掉：锁存一并清掉，避免日后误判「已报过」
  }
  store.save();
  return about;
}

// 每日全量自检（所有网盘各测一次；失败的进入复测节奏；顺带做容量巡检）
export async function dailyCheckAll() {
  const names = await rc.listRemotes().catch(() => []);
  for (const name of names) {
    await testRemote(name, { fromSchedule: true }).catch(() => {});
    // 已暂停的网盘不参加定时巡检（含容量），与连通自检同口径
    if (!store.isPaused(name)) await checkCapacity(name).catch(() => {});
  }
  return names;
}
