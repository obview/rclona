// 时间与容量格式化（全部按浏览器本地时间展示，服务端按 TZ 调度）
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtTimeSec(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${fmtTime(iso)}:${p(d.getSeconds())}`;
}
export function fmtAgo(iso) {
  if (!iso) return '从未';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
export function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
export function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

// 网盘品牌色与简称：概览同步对的大圆标、侧栏小标都用它
const BRANDS = [
  { match: /koofr/i, color: '#1b87c9', label: 'K', name: 'Koofr' },
  { match: /cloudflare|^r2$/i, color: '#f6821f', label: 'R2', name: 'Cloudflare R2' },
  { match: /s3|amazon/i, color: '#e47911', label: 'S3', name: 'Amazon S3' },
  { match: /drive/i, color: '#34a853', label: 'G', name: 'Google Drive' },
  { match: /onedrive/i, color: '#28a8ea', label: 'O', name: 'OneDrive' },
  { match: /dropbox/i, color: '#0061ff', label: 'D', name: 'Dropbox' },
  { match: /webdav/i, color: '#0e9594', label: 'W', name: 'WebDAV' },
  { match: /local/i, color: '#6b7194', label: '本', name: '本地目录' }
];
export function brandOf(remote) {
  const key = `${remote?.name || ''} ${remote?.type || ''}`;
  for (const b of BRANDS) if (b.match.test(key)) return b;
  return { color: '#5b67cf', label: (remote?.name || '?').slice(0, 1).toUpperCase(), name: remote?.type || '' };
}

export function fmtHM(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function scheduleText(s) {
  if (!s) return '未设置';
  switch (s.type) {
    case 'weekly': {
      const days = (s.weekdays && s.weekdays.length ? s.weekdays : [s.weekday ?? 1])
        .map((d) => WEEKDAYS[d]).filter(Boolean).join('、');
      return `每${days} ${s.time}`;
    }
    case 'monthly':
      return `每月 ${s.dayOfMonth} 号 ${s.time}`;
    case 'hours':
      return `每 ${s.intervalHours} 小时`;
    case 'days':
      return `每 ${s.intervalDays} 天 ${s.time}`;
    case 'cron':
      return `cron：${s.cron}`;
    default:
      return `每天 ${s.time}`;
  }
}
