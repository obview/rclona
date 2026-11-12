import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
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

// Telegram 代理：只给 Telegram 通知用（环境变量 TELEGRAM_PROXY，如 http://172.28.0.1:7890）。
// Node 的 http/https 模块不认 HTTP(S)_PROXY，所以这里不用全局代理变量；rclone 走自己的
// 网络（网盘流量），也与本代理无关。没设 TELEGRAM_PROXY 时保持原来的直连。
function telegramProxy() {
  const raw = String(process.env.TELEGRAM_PROXY || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' || !u.hostname) return null;
    return { host: u.hostname, port: Number(u.port || 8080) };
  } catch { return null; }
}

// 经 HTTP 代理发 CONNECT 隧道，再在隧道里做 TLS：
// 代理只负责把 TCP 流送到 api.telegram.org:443，TLS 仍由本机与 Telegram 直接协商，
// 代理看不到令牌和消息内容。返回已完成 TLS 握手的 socket。
async function connectViaProxy(proxy, targetHost, targetPort, timeoutMs) {
  const sock = net.connect({ host: proxy.host, port: proxy.port, family: 4 });
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => { sock.destroy(); reject(new Error('连接代理超时')); }, timeoutMs);
      sock.once('connect', () => { clearTimeout(to); resolve(); });
      sock.once('error', (e) => { clearTimeout(to); reject(e); });
    });
    sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    const head = await new Promise((resolve, reject) => {
      const to = setTimeout(() => { sock.destroy(); reject(new Error('代理 CONNECT 超时')); }, timeoutMs);
      let buf = Buffer.alloc(0);
      const onData = (c) => {
        buf = Buffer.concat([buf, c]);
        const i = buf.indexOf('\r\n\r\n');
        if (i >= 0) {
          clearTimeout(to);
          sock.off('data', onData);
          if (buf.length > i + 4) sock.unshift(buf.subarray(i + 4));
          resolve(buf.subarray(0, i).toString('utf8'));
        }
      };
      sock.on('data', onData);
      sock.once('error', (e) => { clearTimeout(to); reject(e); });
    });
    const statusLine = (head.split('\r\n')[0] || '').trim();
    if (!/^HTTP\/\d+(?:\.\d+)? 200\b/.test(statusLine)) throw new Error(`代理 CONNECT 失败（${statusLine || '无响应'}）`);
    const tlsSock = tls.connect({ socket: sock, servername: targetHost });
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => { tlsSock.destroy(); reject(new Error('TLS 握手超时')); }, timeoutMs);
      tlsSock.once('secureConnect', () => { clearTimeout(to); resolve(); });
      tlsSock.once('error', (e) => { clearTimeout(to); reject(e); });
    });
    return tlsSock;
  } catch (e) {
    try { sock.destroy(); } catch { /* 忽略 */ }
    throw e;
  }
}

// 发一个 JSON POST 并解析 JSON 响应。刻意不用全局 fetch：undici 在「容器没有 IPv6 路由、
// DNS 却返回 AAAA 记录」的常见 Docker 网络里会扑向 IPv6 并长时间挂起直到超时
// （2026-10-23 线上实测：api.telegram.org 的 fetch 挂死、同容器 rclone(Go) 与 IPv4 一切正常，
// 只有走 Node fetch 的 Telegram 通知中招）。改用 http/https 模块并锁定 family:4（IPv4）。
function postJson(urlStr, payload, timeoutMs = 15000) {
  const proxy = telegramProxy();
  if (proxy) return postJsonViaProxy(urlStr, payload, proxy, timeoutMs);
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

// 经 TELEGRAM_PROXY 发 JSON POST：先建 CONNECT 隧道 + TLS，再在这条已建好的加密连接上
// 手写 HTTP 请求、解析响应（不走 https.request 的 createConnection——实测该选项在
// Node 24 里会被默认 Agent 忽略、仍直连目标）。响应解析与直连路径共用同一套逻辑。
function decodeChunked(buf) {
  const out = [];
  let pos = 0;
  for (;;) {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0) break;
    const size = parseInt(buf.subarray(pos, eol).toString('utf8').trim(), 16);
    if (!size) break;
    out.push(buf.subarray(eol + 2, eol + 2 + size));
    pos = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

async function postJsonViaProxy(urlStr, payload, proxy, timeoutMs = 15000) {
  let url;
  try { url = new URL(urlStr); } catch { throw new Error('通知接口地址不正确'); }
  if (url.protocol !== 'https:') throw new Error('代理只支持 https 的通知接口地址');
  const body = JSON.stringify(payload);
  const tlsSock = await connectViaProxy(proxy, url.hostname, Number(url.port || 443), timeoutMs);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { tlsSock.destroy(); reject(new Error('连接 Telegram 接口超时（服务器到 api.telegram.org 的网络不通）')); }, timeoutMs);
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { tlsSock.destroy(); } catch { /* 忽略 */ } fn(v); };
    tlsSock.on('data', (c) => { buf = Buffer.concat([buf, c]); });
    tlsSock.on('end', () => {
      try {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return done(reject, new Error('Telegram 接口返回异常（无响应头）'));
        const headerText = buf.subarray(0, idx).toString('utf8');
        let respBody = buf.subarray(idx + 4);
        const headers = {};
        for (const line of headerText.split('\r\n').slice(1)) {
          const i = line.indexOf(':');
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        if ((headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) respBody = decodeChunked(respBody);
        const status = Number((headerText.split('\r\n')[0].match(/HTTP\/\d+(?:\.\d+)? (\d+)/) || [])[1] || 0);
        let data = {};
        try { data = JSON.parse(respBody.toString('utf8') || '{}'); } catch { /* 非 JSON 响应按空对象处理 */ }
        done(resolve, { status, data });
      } catch (e) { done(reject, e); }
    });
    tlsSock.on('error', (e) => done(reject, e));
    const path = url.pathname + url.search;
    tlsSock.write(`POST ${path} HTTP/1.1\r\nHost: ${url.hostname}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
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
