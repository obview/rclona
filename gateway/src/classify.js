// 把 rclone 的英文报错归类成中文白话原因（顺序敏感：先匹配更具体的）
// 注意「凭证错误」与「权限不足」必须分开：
// - 真凭证错误长这样：InvalidAccessKeyId / SignatureDoesNotMatch / InvalidClientTokenId / 401；
// - AccessDenied（403）只说明「这个凭证无权做这件事」——例如单桶令牌列不出全部桶，凭证本身是好的，
//   归到「权限不足」，绝不能误报成凭证错误（曾把用户的 R2 单桶令牌误判失效，见验收问题 #15）。
const RULES = [
  // #30：双向同步（bisync）的安全中止——单次要删的文件超过任意一边的一半，
  // rclone 自己先拦下（job 报错 too many deletes）。防的是「一边被清空/读错 →
  // 删除被同步到另一边」的经典双向事故，与镜像的删除安全阀是两套机制。
  { kind: 'bisync-guard', re: /too many deletes/i,
    reason: '双向同步这次要删除的文件太多（超过任意一边文件数的一半），已被安全机制拦下、两边文件都没有动。多半是有一边被清空、挂载异常或路径指错了：先检查两个网盘里的文件还在不在，确认无误后重新执行' },
  // #30：双向同步状态失效（上次中途被打断等）——runner 会把状态标记清掉，
  // 下次执行自动以源网盘为准重新对齐一次（resync），这里给兜底人话。
  { kind: 'bisync-state', re: /bisync|resync/i,
    reason: '双向同步的本地状态对不上（上次可能中途被打断）：本次没有动任何文件；下次执行时会自动重新对齐一次（以较新的文件为准，不会拿旧文件覆盖新文件）' },
  // #27：删除安全阀拦下——errText 由 runner 构造（含「安全阀」与具体数字），
  // 这里兜底归类，保证任何经 stageReason 的路径都显示同一口径的人话。
  { kind: 'guard', re: /安全阀|max[-\s]?delete/i,
    reason: '删除安全阀已拦下这次备份（一次要删的文件太多，已中止以防误删；先用「试运行」看清将删清单，或在任务设置里调高上限）' },
  { kind: 'space', re: /no space left|insufficient space|quota exceeded|storage (limit|full)|507|disk full|exceeded.*quota/i,
    reason: '空间不足（目标网盘容量不够，删掉一些文件或扩容后重试）' },
  { kind: 'network', re: /dial tcp|i\/o timeout|connection refused|connection reset|no such host|network is unreachable|econnrefused|enotfound|etimedout|tls handshake|context deadline|server misbehaving|broken pipe|unexpected eof/i,
    reason: '连接不上（网络不通或对方服务暂时不可达）' },
  // #18：Koofr 系后端在「文件与文件夹同名」等冲突时，复制会报
  // "Failed to copy: Invalid response status! Got 400, expected [200]"——目标端明确拒绝这次写入。
  // （#18 的自动跳过已让同名占位不再触发它，这条主要兜底其它目标端/其它冲突。）
  { kind: 'conflict', re: /(failed to copy|failed to move)[\s\S]{0,200}(invalid response status|got 400\b)|invalid response status[\s\S]{0,80}got \d{3}/i,
    reason: '目标网盘拒绝写入某个文件（常见于文件与文件夹同名冲突）' },
  { kind: 'auth', re: /invalidaccesskeyid|signaturedoesnotmatch|invalidclienttokenid|invalid access key|\b401\b|unauthorized|authentication failed|login failed|wrong password|invalid login|invalid credentials|credentials.*(invalid|error)/i,
    reason: '凭证不正确或已失效（密钥 / 应用密码填错了，或已被服务商作废；请到「网盘管理」点「编辑」核对后重试）' },
  { kind: 'permission', re: /accessdenied|access denied|permission denied|operation not permitted|read-only file system|access forbidden|\b403\b/i,
    reason: '权限不足（凭证本身没有问题，但它无权访问这个位置；请检查服务商那边的授权范围）' },
  { kind: 'notfound', re: /\b404\b|not found|no such (file|directory|key)|doesn't exist|directory not found|object not found/i,
    reason: '路径不存在（文件夹可能被改名、移动或删除了）' },
  { kind: 'readonly-src', re: /protected|locked/i,
    reason: '文件被占用或受保护，暂时读不了' }
];

export function classifyError(errText) {
  const text = String(errText || '');
  for (const r of RULES) {
    if (r.re.test(text)) return { kind: r.kind, reasonZh: r.reason };
  }
  return { kind: 'unknown', reasonZh: '未知原因（详情见下方日志）' };
}

// 结合失败阶段，拼出最终给用户看的原因
export function stageReason(stageLabel, errText) {
  const c = classifyError(errText);
  return { kind: c.kind, reasonZh: `「${stageLabel}」这一步失败：${c.reasonZh}` };
}
