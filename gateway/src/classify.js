// 把 rclone 的英文报错归类成中文白话原因（顺序敏感：先匹配更具体的）
const RULES = [
  { kind: 'space', re: /no space left|insufficient space|quota exceeded|storage (limit|full)|507|disk full|exceeded.*quota/i,
    reason: '空间不足（目标网盘容量不够，删掉一些文件或扩容后重试）' },
  { kind: 'network', re: /dial tcp|i\/o timeout|connection refused|connection reset|no such host|network is unreachable|econnrefused|enotfound|etimedout|tls handshake|context deadline|server misbehaving|broken pipe|unexpected eof/i,
    reason: '连接不上（网络不通或对方服务暂时不可达）' },
  { kind: 'auth', re: /\b401\b|\b403\b|unauthorized|accessdenied|access denied|signaturedoesnotmatch|invalid access key|invalidaccesskeyid|authentication failed|login failed|wrong password|invalid login|credentials.*(invalid|error)|failed to get/i,
    reason: '凭证不正确或已失效（请到「网盘管理」检查密钥 / 应用密码是否填对、是否过期）' },
  { kind: 'notfound', re: /\b404\b|not found|no such (file|directory|key)|doesn't exist|directory not found|object not found/i,
    reason: '路径不存在（文件夹可能被改名、移动或删除了）' },
  { kind: 'permission', re: /permission denied|operation not permitted|read-only file system|access forbidden/i,
    reason: '没有权限（这个位置不可写或不让访问）' },
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
