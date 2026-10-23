import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon, BrandBadge } from './components.jsx';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Tasks from './pages/Tasks.jsx';
import Runs from './pages/Runs.jsx';
import Remotes from './pages/Remotes.jsx';
import RemoteDetail from './pages/RemoteDetail.jsx';
import Settings from './pages/Settings.jsx';
import Profile from './pages/Profile.jsx';

const NAV = [
  { key: 'overview', label: '概览', icon: 'home' },
  { key: 'tasks', label: '备份任务', icon: 'sync' },
  { key: 'runs', label: '运行记录', icon: 'history' },
  { key: 'remotes', label: '网盘管理', icon: 'drive' }
];
const PAGE_KEYS = [...NAV.map((n) => n.key), 'settings', 'profile', 'remoteDetail'];
const TITLES = { overview: '概览', tasks: '备份任务', runs: '运行记录', remotes: '网盘管理', settings: '设置', profile: '个人资料', remoteDetail: '网盘详情' };

function routeFromHash() {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
  return PAGE_KEYS.includes(h) ? h : 'overview';
}

// #12：Telegram 通知里的直达链接形如 /runs?focus=记录ID（也兼容 #/runs?focus= 写法）
function focusFromUrl() {
  try {
    const s = new URLSearchParams(location.search).get('focus');
    if (s) return s;
    const h = location.hash || '';
    const qi = h.indexOf('?');
    if (qi >= 0) return new URLSearchParams(h.slice(qi + 1)).get('focus') || '';
  } catch { /* 地址异常就当没有 */ }
  return '';
}
const DEEP_FOCUS = focusFromUrl();

export function driveDotClass(d) {
  if (d.paused) return 'dot-paused';
  const s = d.health?.status;
  if (s === 'down') return 'dot-bad';
  if (s === 'retrying') return 'dot-warn';
  if (s === 'ok') return 'dot-ok';
  return 'dot-unknown';
}

export default function App() {
  const [me, setMe] = useState(null);
  const [page, setPage] = useState(() => (DEEP_FOCUS ? 'runs' : routeFromHash()));
  const [drives, setDrives] = useState([]);
  const [toastMsg, setToastMsg] = useState(null);
  const [runToasts, setRunToasts] = useState([]); // #10 任务完成通知条
  const [focusRun, setFocusRun] = useState({ id: DEEP_FOCUS, n: DEEP_FOCUS ? 1 : 0 });
  const [navOpen, setNavOpen] = useState(false); // #11 手机抽屉侧栏开关
  const [detailRemote, setDetailRemote] = useState(''); // #31 当前查看详情的网盘名
  const [addRemoteSignal, setAddRemoteSignal] = useState(0); // #32 侧栏「添加网盘」直达表单的信号（计数器，每点一次 +1）
  const [userMenuOpen, setUserMenuOpen] = useState(false); // #23 侧栏底部头像菜单
  const userMenuRef = useRef(null);
  const runStatusRef = useRef(null); // 运行记录 id -> 上次见到的状态（null=还没初始化）

  function toast(text, isErr = false) {
    setToastMsg({ text, isErr });
    setTimeout(() => setToastMsg(null), 3600);
  }
  function nav(key) {
    location.hash = '/' + key;
    setPage(key);
    setNavOpen(false); // 抽屉模式下点完导航自动收起
    setUserMenuOpen(false);
  }
  function gotoRun(runId) {
    setFocusRun((f) => ({ id: runId, n: f.n + 1 }));
    nav('runs');
  }
  // #31：进网盘详情页（侧栏网盘行、网盘管理页都走这里）
  function gotoRemoteDetail(name) {
    setDetailRemote(name);
    nav('remoteDetail');
  }
  // #32：侧栏「添加网盘」——去网盘页并让它自动打开添加表单（信号被 Remotes 消费，刷新不会重弹）
  function gotoAddRemote() {
    setAddRemoteSignal((n) => n + 1);
    nav('remotes');
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
    // 深链进来时把地址栏规整成站内 hash 路由（focus 已存进 state，刷新不会丢定位）
    if (DEEP_FOCUS && (location.search || location.pathname !== '/')) {
      history.replaceState(null, '', '/#/runs');
    }
    const fn = () => setPage(routeFromHash());
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  useEffect(() => { if (me?.authed) loadDrives(); }, [me, page]);

  // #23：头像菜单打开时，点菜单外或按 Escape 自动收起
  useEffect(() => {
    if (!userMenuOpen) return;
    const onPointerDown = (e) => {
      if (!userMenuRef.current?.contains(e.target)) setUserMenuOpen(false);
    };
    const onKeyDown = (e) => { if (e.key === 'Escape') setUserMenuOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [userMenuOpen]);

  // #10：轮询运行记录，面板打开期间有任务新完成（成功/失败）就弹右下角通知条
  useEffect(() => {
    if (!me?.authed) return;
    let alive = true;
    async function poll() {
      try {
        const d = await api.get('/runs?limit=15');
        if (!alive) return;
        const list = d.runs || [];
        const first = runStatusRef.current === null;
        if (first) runStatusRef.current = new Map();
        const known = runStatusRef.current;
        const fresh = [];
        for (const r of list) {
          const prev = known.get(r.id);
          // 新出现或状态从「进行中」变为成功/失败，都算「刚刚完成」；首次轮询只登记不弹
          if (!first && prev !== r.status && (r.status === 'success' || r.status === 'failed')) fresh.push(r);
          known.set(r.id, r.status);
        }
        for (const r of fresh.reverse()) {
          setRunToasts((prev) => [...prev.slice(-2), { id: r.id, taskName: r.taskName, status: r.status, reasonZh: r.reasonZh }]);
          setTimeout(() => {
            setRunToasts((prev) => prev.filter((t) => t.id !== r.id));
          }, 12000);
        }
      } catch { /* 网络抖动忽略，下一轮再试 */ }
    }
    poll();
    const t = setInterval(poll, 6000);
    return () => { alive = false; clearInterval(t); };
  }, [me?.authed]);

  if (me === null) return <div className="loading-page" style={{ paddingTop: 120 }}><span className="spin" /> 加载中…</div>;
  if (!me.authed) return <Login me={me} onAuthed={checkMe} />;

  async function logout() {
    setUserMenuOpen(false);
    await api.post('/auth/logout').catch(() => {});
    setMe({ authed: false, needsSetup: false });
  }

  return (
    <div className="layout">
      {navOpen && <div className="side-mask" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar${navOpen ? ' open' : ''}`}>
        <div className="brand">
          <div className="brand-name">
            <span className="logo-mark"><Icon name="cloud" size={18} /></span><span className="brand-text">rclona</span>
          </div>
          <div className="brand-sub">网盘备份面板</div>
        </div>
        <div className="side-section">功能</div>
        <nav>
          {NAV.map((n) => (
            <button key={n.key} className={`nav-item${page === n.key ? ' active' : ''}`} onClick={() => nav(n.key)}>
              <Icon name={n.icon} size={17} /><span className="nav-label">{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="side-section">我的网盘</div>
        <div className="side-drives">
          {drives.map((d) => (
            <button className="drive-row" key={d.name} onClick={() => gotoRemoteDetail(d.name)}
              title={d.paused ? `${d.name}（已暂停）· 点开看详情` : `${d.name} · 点开看详情`}>
              <BrandBadge remote={d} size={19} />
              <span className="dname">{d.name}</span>
              <span className="badge-num">{d.paused ? '已暂停' : d.type}</span>
              <span className={`status-dot ${driveDotClass(d)}`} />
            </button>
          ))}
          <button className="drive-row" onClick={gotoAddRemote}>
            <Icon name="plus" size={14} /><span className="dname">添加网盘</span>
          </button>
        </div>
        <div className="side-foot">
          <div className="side-user-wrap" ref={userMenuRef}>
            <button type="button" className="side-avatar-btn" title="个人资料与账号"
              aria-label="打开个人资料菜单" aria-haspopup="menu" aria-expanded={userMenuOpen}
              onClick={() => setUserMenuOpen((v) => !v)}>
              <span className="avatar">{(me.user || '?').slice(0, 1).toUpperCase()}</span>
            </button>
            {userMenuOpen && (
              <div className="side-user-menu" role="menu" aria-label="账号菜单">
                <button type="button" role="menuitem" onClick={() => nav('profile')}>
                  <Icon name="user" size={16} /> 个人资料
                </button>
                <button type="button" role="menuitem" className="menu-logout" onClick={logout}>
                  <Icon name="logout" size={16} /> 退出登录
                </button>
              </div>
            )}
          </div>
          <button type="button" className={`side-gear-btn${page === 'settings' ? ' active' : ''}`}
            title="设置" aria-label="打开设置" onClick={() => nav('settings')}>
            <Icon name="gear" size={19} />
          </button>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button className="nav-toggle" aria-label="打开菜单" onClick={() => setNavOpen(true)}>
            <Icon name="menu" size={21} />
          </button>
          <span className="crumb">rclona / {TITLES[page]}</span>
          <div className="spacer" />
        </div>
        <div className="page">
          {page === 'overview' && <Overview nav={nav} gotoRun={gotoRun} />}
          {page === 'tasks' && <Tasks toast={toast} />}
          {page === 'runs' && <Runs key={focusRun.n} focusRunId={focusRun.id} />}
          {page === 'remotes' && <Remotes toast={toast} nav={nav} gotoDetail={gotoRemoteDetail} openAddSignal={addRemoteSignal} onConsumeAddSignal={() => setAddRemoteSignal(0)} />}
          {page === 'remoteDetail' && <RemoteDetail key={detailRemote} name={detailRemote} nav={nav} toast={toast} />}
          {page === 'settings' && <Settings toast={toast} />}
          {page === 'profile' && <Profile me={me} toast={toast} />}
        </div>
      </div>

      {toastMsg && <div className={`toast${toastMsg.isErr ? ' err' : ''}`}>{toastMsg.text}</div>}

      {/* #10 任务完成通知条（右下角） */}
      <div className="run-toasts">
        {runToasts.map((t) => (
          <div key={t.id} className={`run-toast ${t.status}`}
            onClick={() => { setRunToasts((prev) => prev.filter((x) => x.id !== t.id)); gotoRun(t.id); }}>
            <span className="rt-ico"><Icon name={t.status === 'success' ? 'check' : 'x'} size={15} sw={2.6} /></span>
            <span className="rt-text">
              「{t.taskName}」{t.status === 'success' ? '备份成功' : `备份失败${t.reasonZh ? `：${t.reasonZh}` : ''}`}
            </span>
            <button className="rt-x" aria-label="关闭通知"
              onClick={(e) => { e.stopPropagation(); setRunToasts((prev) => prev.filter((x) => x.id !== t.id)); }}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}
