import http from 'node:http';
import https from 'node:https';
import { store } from './store.js';
import { cfg } from './config.js';
import { scheduleText } from './schedule.js';

// 通知走 Telegram 机器人：配置来自设置页（Bot Token + Chat ID，存本地记录）
function tg() {
  return store.data.settings.telegram || {};
}
export function telegramReady() {
  const t = tg();
  return !!(t.enabled && t.botToken && t.chatId);
}

// 发一个 JSON POST 并解析 JSON 响应。刻意不用全局 fetch：undici 在「容器没有 IPv6 路由、
// DNS 却返回 AAAA 记录」的常见 Docker 网络里会扑向 IPv6 并长时间挂起直到超时
// （2026-10-23 线上实测：api.telegram.org 的 fetch 挂死、同容器 rclone(Go) 与 IPv4 一切正常，
// 只有走 Node fetch 的 Telegram 通知中招）。改用 http/https 模块并锁定 family:4（IPv4）。
function postJson(urlStr, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch { reject(new Error('通知接口地址不正确')); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = lib.request(url, {
      method: 'POST',
      family: 4,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 非 JSON 响应按空对象处理 */ }
        resolve({ status: res.statusCode || 0, data });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('连接 Telegram 接口超时（服务器到 api.telegram.org 的网络不通）')));
    req.on('error', reject);
    req.end(body);
  });
}

async function sendTelegram(text, { force = false } = {}) {
  const t = tg();
  if (!t.enabled && !force) return { skipped: '通知未开启' };
  if (!t.botToken || !t.chatId) return { skipped: 'Telegram 配置不完整（缺机器人令牌或 Chat ID）' };
  const { status, data } = await postJson(`${cfg.telegramApiBase}/bot${t.botToken}/sendMessage`, {
    chat_id: t.chatId, text
  });
  if (status < 200 || status >= 300 || data.ok === false) {
    throw new Error(data.description || `Telegram 接口返回 ${status}（请检查令牌与 Chat ID）`);
  }
  return { sent: true };
}

function fmtWhen(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false, timeZone: cfg.tz });
  } catch { return iso || ''; }
}

// 用户在设置里填的「面板访问地址」（如 https://panel.example.com）；填了通知才附直达链接，没填就不附
function panelBase() {
  const a = String(tg().panelAddress || '').trim().replace(/\/+$/, '');
  return a || '';
}
function linkLine(path) {
  const base = panelBase();
  return base ? `\n直达链接：${base}${path}` : '';
}

export async function notifyBackupFailure(run) {
  try {
    await sendTelegram([
      `备份失败：${run.taskName}`,
      `时间：${fmtWhen(run.startedAt)}`,
      `失败阶段：${run.failedStageLabel || '未知阶段'}`,
      `原因：${run.reasonZh || '未知原因'}`,
      '',
      '处理完后，别忘了在面板的「运行记录」里把这条标为「已处理」。' + linkLine(`/runs?focus=${run.id}`)
    ].join('\n'));
  } catch (e) {
    console.error('[notify] 备份失败通知发送失败：', e.message);
  }
}

function fmtBytes(n) {
  const v0 = Number(n) || 0;
  if (v0 < 1024) return `${v0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = v0 / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

// #24：某个任务第一次「按定时计划自动跑成功」时报喜一次——让用户确信定时链路真的通了。
// 只由 runner 在 trigger==='schedule' 且成功、且任务未打过标记时调用；手动成功永不触发。
export async function notifyFirstScheduledSuccess(run, task) {
  try {
    await sendTelegram([
      `✅ 定时备份首次成功：${run.taskName}`,
      `源网盘 → 目标网盘：${task.srcRemote} → ${task.dstRemote}`,
      `本次传输：${run.stats?.transferred ?? 0} 个文件 / ${fmtBytes(run.stats?.bytes ?? 0)}`,
      `计划：${scheduleText(task.schedule)}`,
      '',
      '这是这个任务第一次按定时计划自动跑成功，之后会照这个计划继续自动备份，不用再手动管它。' + linkLine(`/runs?focus=${run.id}`)
    ].join('\n'));
  } catch (e) {
    console.error('[notify] 定时备份首次成功通知发送失败：', e.message);
  }
}

export async function notifyRemoteDown(remoteName, causeZh) {
  try {
    await sendTelegram([
      `网盘连接失效：${remoteName}`,
      `网盘「${remoteName}」已经连不上了（多次复测都失败），依赖它的备份会受影响。`,
      `原因：${causeZh}`,
      '',
      '常见处理：检查网盘服务是否正常、密钥/应用密码是否过期，然后在面板「网盘管理」里点「测试连接」。',
      '恢复连接后会再发一条通知告诉你。' + linkLine('/remotes')
    ].join('\n'));
  } catch (e) {
    console.error('[notify] 网盘失效通知发送失败：', e.message);
  }
}

export async function notifyRemoteRecovered(remoteName) {
  try {
    await sendTelegram([
      `网盘已恢复：${remoteName}`,
      `网盘「${remoteName}」连接已恢复正常，依赖它的备份可以照常进行。` + linkLine('/remotes')
    ].join('\n'));
  } catch (e) {
    console.error('[notify] 网盘恢复通知发送失败：', e.message);
  }
}

// #27 B 段：网盘快满提醒（由每日自检的容量巡检触发，同一轮超限只报一次，口径见 health.js）
export async function notifyCapacityAlert(remoteName, usedPercent, about, threshold) {
  try {
    await sendTelegram([
      `⚠️ 网盘快满了：${remoteName}`,
      `网盘「${remoteName}」已用 ${usedPercent}%（提醒阈值 ${threshold}%）。`,
      about ? `容量：共 ${fmtBytes(about.total)}，已用 ${fmtBytes(about.used ?? 0)}，剩余 ${fmtBytes(about.free ?? 0)}。` : '',
      '',
      '备份都是往里写的，满了之后新的备份会失败。处理办法：删掉网盘里不要的旧文件、清理 rclona 的旧版本归档，或者给网盘扩容/换更大的套餐。',
      '容量降回阈值以下后，如果再涨上去会再提醒你。' + linkLine('/remotes')
    ].filter(Boolean).join('\n'));
  } catch (e) {
    console.error('[notify] 网盘容量提醒发送失败：', e.message);
  }
}

export async function sendTestTelegram() {
  const t = tg();
  if (!t.botToken) throw new Error('请先填写机器人令牌（Bot Token）');
  if (!t.chatId) throw new Error('请先填写 Chat ID');
  // 测试发送不受开关影响（开关只管自动通知）
  await sendTelegram('这是一条来自 rclona 的测试通知。收到它，说明 Telegram 通知配置已经通了。', { force: true });
  return { sent: true };
}
