// 把 rclone 的英文报错归类成中文白话原因（顺序敏感：先匹配更具体的）
// 注意「凭证错误」与「权限不足」必须分开：
// - 真凭证错误长这样：InvalidAccessKeyId / SignatureDoesNotMatch / InvalidClientTokenId / 401；
// - AccessDenied（403）只说明「这个凭证无权做这件事」——例如单桶令牌列不出全部桶，凭证本身是好的，
//   归到「权限不足」，绝不能误报成凭证错误（曾把用户的 R2 单桶令牌误判失效，见验收问题 #15）。
const RULES = [
  { kind: 'space', re: /no space left|insufficient space|quota exceeded|storage (limit|full)|507|disk full|exceeded.*quota/i,
    reason: '空间不足（目标网盘容量不够，删掉一些文件或扩容后重试）' },
  { kind: 'network', re: /dial tcp|i\/o timeout|connection refused|connection reset|no such host|network is unreachable|econnrefused|enotfound|etimedout|tls handshake|context deadline|server misbehaving|broken pipe|unexpected eof/i,
    reason: '连接不上（网络不通或对方服务暂时不可达）' },
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
