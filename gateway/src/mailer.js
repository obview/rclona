import nodemailer from 'nodemailer';
import { store} from './store.js';

// 失败通知邮件：配置来自设置页（存本地记录），发件走用户自己的邮箱 SMTP
function transport() {
const { smtp} = store.data.settings;
if (!smtp.host ||!smtp.user ||!smtp.pass) return null;
return nodemailer.createTransport({
host: smtp.host,
port: Number(smtp.port) || 465,
secure: smtp.secure!== false,
auth: { user: smtp.user, pass: smtp.pass}
});
}
export function mailReady() {
const { notify} = store.data.settings;
return!!(notify.enabled && notify.to && transport());
}

async function send(subject, text) {
const { notify, smtp} = store.data.settings;
if (!notify.enabled ||!notify.to) return { skipped: '通知未开启或未填收件邮箱'};
const t = transport();
if (!t) return { skipped: 'SMTP 配置不完整'};
await t.sendMail({ from: smtp.user, to: notify.to, subject, text});
return { sent: true};
}

export async function sendBackupFailureMail(run) {
try {
await send(
`备份失败：${run.taskName}`,
[
`备份任务「${run.taskName}」执行失败。`,
`时间：${run.startedAt}`,
`失败阶段：${run.failedStageLabel || '未知阶段'}`,
`原因：${run.reasonZh || '未知原因'}`,
'',
'处理完后，别忘了在面板的「运行记录」里把这条标为「已处理」。'
].join('\n')
);
} catch (e) {
console.error('[mail] 备份失败通知发送失败：', e.message);
}
}

export async function sendRemoteDownMail(remoteName, causeZh) {
try {
await send(
`网盘连接失效：${remoteName}`,
[
`网盘「${remoteName}」已经连不上了（多次复测都失败），依赖它的备份会受影响。`,
`原因：${causeZh}`,
'',
'常见处理：检查网盘服务是否正常、密钥/应用密码是否过期，然后在面板「网盘管理」里点「测试连接」。',
'恢复连接后状态会自动解除。'
].join('\n')
);
} catch (e) {
console.error('[mail] 网盘失效通知发送失败：', e.message);
}
}

export async function sendTestMail() {
const { notify, smtp} = store.data.settings;
if (!notify.to) throw new Error('请先填写收件邮箱');
const t = transport();
if (!t) throw new Error('SMTP 配置不完整（服务器/账号/授权码都要填）');
await t.sendMail({
from: smtp.user, to: notify.to,
subject: '测试邮件',
text: '这是一封来自 rclona 的测试邮件。收到它，说明失败通知的邮件配置已经通了。'
});
return { sent: true};
}
