import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Icon, BrandBadge } from './components.jsx';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Tasks from './pages/Tasks.jsx';
import Runs from './pages/Runs.jsx';
import Remotes from './pages/Remotes.jsx';
import Settings from './pages/Settings.jsx';

const NAV = [
  { key: 'overview', label: '概览', icon: 'home' },
  { key: 'tasks', label: '备份任务', icon: 'sync' },
  { key: 'runs', label: '运行记录', icon: 'history' },
  { key: 'remotes', label: '网盘管理', icon: 'drive' },
  { key: 'settings', label: '设置', icon: 'gear' }
];
const TITLES = { overview: '概览', tasks: '备份任务', runs: '运行记录', remotes: '网盘管理', settings: '设置' };

function routeFromHash() {
  const h = location.hash.replace(/^#\/?/, '');
  return NAV.some((n) => n.key === h) ? h : 'overview';
}

export default function App() {
  const [me, setMe] = useState(null);
  const [page, setPage] = useState(routeFromHash());
  const [drives, setDrives] = useState([]);
  const [toastMsg, setToastMsg] = useState(null);

  function toast(text, isErr = false) {
    setToastMsg({ text, isErr });
    setTimeout(() => setToastMsg(null), 3600);
  }
  function nav(key) {
    location.hash = '/' + key;
    setPage(key);
  }
  async function checkMe() {
    try { setMe(await api.get('/auth/me')); }
    catch { setMe({ authed: false, needsSetup: false }); }
  }
  async function loadDrives() {
    try { const d = await api.get('/remotes'); setDrives(d.remotes || []); } catch { /* 未登录时忽略 */ }
  }
  useEffect(() => {
    checkMe();
    const fn = () => setPage(routeFromHash());
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  useEffect(() => { if (me?.authed) loadDrives(); }, [me, page]);

  if (me === null) return <div className="loading-page" style={{ paddingTop: 120 }}><span className="spin" /> 加载中…</div>;
  if (!me.authed) return <Login me={me} onAuthed={checkMe} />;

  async function logout() {
    await api.post('/auth/logout').catch(() => {});
    setMe({ authed: false, needsSetup: false });
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">
            <span className="logo-mark"><Icon name="cloud" size={18} /></span>rclona
          </div>
          <div className="brand-sub">网盘备份面板</div>
        </div>
        <div className="side-section">功能</div>
        <nav>
          {NAV.map((n) => (
            <button key={n.key} className={`nav-item${page === n.key ? ' active' : ''}`} onClick={() => nav(n.key)}>
              <Icon name={n.icon} size={17} />{n.label}
            </button>
          ))}
        </nav>
        <div className="side-section">我的网盘</div>
        <div className="side-drives">
          {drives.length === 0 && (
            <button className="drive-row" onClick={() => nav('remotes')}>
              <Icon name="plus" size={14} /><span className="dname">添加网盘</span>
            </button>
          )}
          {drives.map((d) => (
            <button className="drive-row" key={d.name} onClick={() => nav('remotes')} title={d.name}>
              <span className={`status-dot ${d.health?.status === 'down' ? 'dot-bad' : d.health?.status === 'retrying' ? 'dot-warn' : d.health?.status === 'ok' ? 'dot-ok' : 'dot-unknown'}`} />
              <BrandBadge remote={d} size={19} />
              <span className="dname">{d.name}</span>
              <span className="badge-num">{d.type}</span>
            </button>
          ))}
        </div>
        <div className="side-foot">
          <button onClick={logout}><Icon name="logout" size={14} /> 退出登录</button>
          <div style={{ marginTop: 8 }}>账号：{me.user}</div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <span className="crumb">rclona / {TITLES[page]}</span>
          <div className="spacer" />
          <div className="user-chip">
            <span className="avatar">{(me.user || '?').slice(0, 1).toUpperCase()}</span>
            {me.user}
          </div>
        </div>
        <div className="page">
          {page === 'overview' && <Overview nav={nav} />}
          {page === 'tasks' && <Tasks toast={toast} />}
          {page === 'runs' && <Runs />}
          {page === 'remotes' && <Remotes toast={toast} nav={nav} />}
          {page === 'settings' && <Settings toast={toast} />}
        </div>
      </div>

      {toastMsg && <div className={`toast${toastMsg.isErr ? ' err' : ''}`}>{toastMsg.text}</div>}
    </div>
  );
}
