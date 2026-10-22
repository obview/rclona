import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { brandOf } from './util.js';

// ---------- 图标（内联 SVG，描边风格） ----------
const PATHS = {
  cloud: 'M7 18a4.5 4.5 0 1 1 .7-8.93A5.5 5.5 0 0 1 18.3 11 3.8 3.8 0 0 1 17.5 18z',
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  sync: 'M20 12a8 8 0 0 1-14.2 5.1M4 12a8 8 0 0 1 14.2-5.1M18.5 3v4h-4M5.5 21v-4h4',
  history: 'M3.5 12a8.5 8.5 0 1 1 2.5 6M3.5 12H7m-3.5 0V8.5M12 8v4l3 2',
  drive: 'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 15.5h.01M12 15.5h4',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.36.95a7 7 0 0 0-2.42-1.4L13.7 2.6h-3.4l-.38 2.54a7 7 0 0 0-2.42 1.4l-2.36-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.8l-2 1.55 2 3.46 2.36-.95a7 7 0 0 0 2.42 1.4l.38 2.54h3.4l.38-2.54a7 7 0 0 0 2.42-1.4l2.36.95 2-3.46-2-1.55c.1-.45.14-.92.14-1.4z',
  check: 'M4.5 12.5l5 5 10-11',
  x: 'M6 6l12 12M18 6L6 18',
  warn: 'M12 4L2.8 20h18.4zM12 10v4.5m0 2.7v.3',
  arrow: 'M4 12h15m-6-7 7 7-7 7',
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  play: 'M7 4.8v14.4L19 12z',
  trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 7',
  bell: 'M6 16v-5a6 6 0 1 1 12 0v5l1.5 3h-15zM10 21a2.2 2.2 0 0 0 4 0',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 3v4h-4',
  up: 'M12 19V5m-6 6 6-6 6 6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m3 14 5-5-5-5m5 5H9'
};
export function Icon({ name, size = 18, sw = 1.8 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] || PATHS.cloud} />
    </svg>
  );
}

// ---------- 网盘品牌圆标 ----------
export function BrandBadge({ remote, size = 46, fontSize }) {
  const b = brandOf(remote);
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: b.color, color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 700, fontSize: fontSize || Math.round(size * 0.36), flex: '0 0 auto'
    }}>{b.label}</div>
  );
}

// ---------- 记录的大状态图标 ----------
export function BigStatus({ run }) {
  if (run.status === 'running') return <div className="big-status run"><span className="spin" style={{ width: 22, height: 22 }} /></div>;
  if (run.status === 'success') return <div className="big-status ok"><Icon name="check" size={24} sw={2.4} /></div>;
  if (run.status === 'failed' && run.handledAt) return <div className="big-status handled"><Icon name="check" size={24} sw={2.4} /></div>;
  return <div className="big-status fail"><Icon name="x" size={22} sw={2.4} /></div>;
}

export function RunStatusWord({ run }) {
  if (run.status === 'running') return <span className="status-word word-run">备份中…</span>;
  if (run.status === 'success') return <span className="status-word word-ok">备份成功</span>;
  if (run.status === 'failed' && run.handledAt) return <span className="status-word word-ok">已处理</span>;
  return <span className="status-word word-bad">备份失败</span>;
}

// ---------- 五阶段链 ----------
export const STAGE_LABELS = ['连接源网盘', '扫描比对', '连接目标网盘', '传输文件', '校验'];
export function StageChain({ stages }) {
  return (
    <div className="stage-chain">
      {STAGE_LABELS.map((label, i) => {
        const st = stages?.[i]?.status || 'pending';
        return (
          <React.Fragment key={label}>
            {i > 0 && <span className="stage-link" />}
            <span className={`stage ${st === 'ok' ? 'done' : st === 'failed' ? 'failed' : st === 'running' ? 'running' : 'pending'}`}>
              <span className="s-ico">
                {st === 'ok' ? <Icon name="check" size={12} sw={3} />
                  : st === 'failed' ? <Icon name="x" size={11} sw={3} />
                  : st === 'running' ? <span className="spin" style={{ width: 11, height: 11, borderWidth: 2 }} />
                  : (i + 1)}
              </span>
              {label}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ---------- 弹窗 ----------
export function Modal({ title, sub, wide, onClose, children, foot }) {
  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);
  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal${wide ? ' wide' : ''}`}>
        <div className="modal-head">
          <div>
            <div className="m-title">{title}</div>
            {sub && <div className="m-sub">{sub}</div>}
          </div>
          <button className="x-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

// ---------- 文件夹选择器（学 Air Explorer / odrive：面包屑 + 纯目录列表） ----------
// 本地目录网盘从文件系统根「/」开始浏览（绝对路径）；其余网盘用相对路径（桶/目录）
export function FolderPicker({ remote, remoteType, value, onChange }) {
  const root = remoteType === 'local' ? '/' : '';
  const [path, setPath] = useState(value || root);
  const [dirs, setDirs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function load(p) {
    if (!remote) return;
    setLoading(true); setErr('');
    try {
      const d = await api.get(`/browse?remote=${encodeURIComponent(remote)}&path=${encodeURIComponent(p)}`);
      setDirs(d.dirs || []);
      setPath(p);
      onChange(p);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }
  useEffect(() => { if (remote) load(value || root); /* eslint-disable-next-line */ }, [remote]);

  if (!remote) return <div className="info-box">先在上方选择网盘，这里就能浏览并选择文件夹。</div>;
  const segments = path.split('/').filter(Boolean);
  const isAbs = path.startsWith('/');
  const joinSegs = (n) => (isAbs ? '/' : '') + segments.slice(0, n).join('/');
  const parentPath = segments.length <= 1 ? root : joinSegs(segments.length - 1);
  return (
    <div>
      <div className="crumb-nav">
        <button onClick={() => load(root)}>{remote} 根目录</button>
        {segments.map((c, i) => (
          <span key={i}>/ <button onClick={() => load(joinSegs(i + 1))}>{c}</button></span>
        ))}
        <span style={{ marginLeft: 'auto', color: 'var(--text-3)' }}>已选：{path || '/（根目录）'}</span>
      </div>
      {err && <div className="login-err">{err}</div>}
      <div className="folder-list">
        {path !== root && (
          <div className="folder-item" onClick={() => load(parentPath)}>
            <Icon name="up" size={15} /> 返回上一级
          </div>
        )}
        {loading && <div className="folder-item" style={{ color: 'var(--text-3)' }}>加载中…</div>}
        {!loading && dirs.length === 0 && <div className="folder-item" style={{ color: 'var(--text-3)' }}>（没有子文件夹，就选当前目录即可）</div>}
        {!loading && dirs.map((d) => (
          <div className="folder-item" key={d.path} onClick={() => load(d.path)}>
            <span style={{ color: '#e8a13a' }}><Icon name="folder" size={16} /></span>{d.name}
          </div>
        ))}
      </div>
    </div>
  );
}
