import { store } from './store.js';
import { cfg } from './config.js';

// 通知走 Telegram 机器人：配置来自设置页（Bot Token + Chat ID，存本地记录）
function tg() {
  return store.data.settings.telegram || {};
}
export function telegramReady() {
  const t = tg();
  return !!(t.enabled && t.botToken && t.chatId);
}

async function sendTelegram(text, { force = false } = {}) {
  const t = tg();
  if (!t.enabled && !force) return { skipped: '通知未开启' };
  if (!t.botToken || !t.chatId) return { skipped: 'Telegram 配置不完整（缺机器人令牌或 Chat ID）' };
  const res = await fetch(`${cfg.telegramApiBase}/bot${t.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: t.chatId, text }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.description || `Telegram 接口返回 ${res.status}（请检查令牌与 Chat ID）`);
  }
  return { sent: true };
}

function fmtWhen(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false, timeZone: cfg.tz });
  } catch { return iso || ''; }
}

export async function notifyBackupFailure(run) {
  try {
    await sendTelegram([
      `备份失败：${run.taskName}`,
      `时间：${fmtWhen(run.startedAt)}`,
      `失败阶段：${run.failedStageLabel || '未知阶段'}`,
      `原因：${run.reasonZh || '未知原因'}`,
      '',
      '处理完后，别忘了在面板的「运行记录」里把这条标为「已处理」。'
    ].join('\n'));
  } catch (e) {
    console.error('[notify] 备份失败通知发送失败：', e.message);
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
      '恢复连接后会再发一条通知告诉你。'
    ].join('\n'));
  } catch (e) {
    console.error('[notify] 网盘失效通知发送失败：', e.message);
  }
}

export async function notifyRemoteRecovered(remoteName) {
  try {
    await sendTelegram([
      `网盘已恢复：${remoteName}`,
      `网盘「${remoteName}」连接已恢复正常，依赖它的备份可以照常进行。`
    ].join('\n'));
  } catch (e) {
    console.error('[notify] 网盘恢复通知发送失败：', e.message);
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
