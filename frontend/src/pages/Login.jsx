import React, { useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../components.jsx';

export default function Login({ me, onAuthed }) {
  const [user, setUser] = useState(me?.suggestedUser || '');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setup = me?.needsSetup;

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (setup && pass !== pass2) { setErr('两次输入的密码不一致'); return; }
    if (setup && pass.length < 8) { setErr('密码至少 8 位'); return; }
    setBusy(true);
    try {
      if (setup) await api.post('/auth/setup', { user: user.trim(), password: pass });
      else await api.post('/auth/login', { user: user.trim(), password: pass });
      onAuthed();
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="l-brand">
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
            <span style={{ width: 52, height: 52, borderRadius: 15, background: 'var(--indigo-600)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="cloud" size={29} />
            </span>
          </div>
          <div className="bname">rclona</div>
          <div className="bsub">{setup ? '首次使用，先给面板设置一个账号密码' : '网盘备份面板，登录后继续'}</div>
        </div>
        {err && <div className="login-err">{err}</div>}
        <div className="field" style={{ marginBottom: 13 }}>
          <label>账号</label>
          <input className="input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="登录账号" autoFocus />
        </div>
        <div className="field" style={{ marginBottom: setup ? 13 : 20 }}>
          <label>密码</label>
          <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={setup ? '至少 8 位' : '登录密码'} />
        </div>
        {setup && (
          <div className="field" style={{ marginBottom: 20 }}>
            <label>再输一遍密码</label>
            <input className="input" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
          </div>
        )}
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '11px 18px' }} disabled={busy}>
          {busy ? '请稍候…' : setup ? '创建并登录' : '登录'}
        </button>
        <div style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 12, marginTop: 16 }}>
          基于 rclone 的开源备份面板
        </div>
      </form>
    </div>
  );
}
