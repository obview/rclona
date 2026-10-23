import React, { useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../components.jsx';

export default function Profile({ me, toast }) {
  const [pw, setPw] = useState({ old: '', next: '', next2: '' });
  const [saving, setSaving] = useState(false);

  async function changePassword() {
    if (!pw.old) { toast('请输入当前密码', true); return; }
    if (pw.next.length < 8) { toast('新密码至少 8 位', true); return; }
    if (pw.next !== pw.next2) { toast('两次输入的新密码不一致', true); return; }
    setSaving(true);
    try {
      await api.post('/auth/password', { oldPassword: pw.old, newPassword: pw.next });
      toast('密码已修改，下次登录请使用新密码');
      setPw({ old: '', next: '', next2: '' });
    } catch (e) { toast(e.message, true); }
    setSaving(false);
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">个人资料</div>
          <div className="page-sub">查看当前账号，并在这里修改登录密码</div>
        </div>
      </div>

      <div className="card card-pad profile-card">
        <div className="card-title">账号信息</div>
        <div className="card-sub">用户名用于登录面板，目前不能修改</div>
        <div className="field" style={{ marginTop: 16 }}>
          <label>当前用户名</label>
          <input className="input" value={me.user || ''} disabled autoComplete="username" />
        </div>

        <div className="profile-divider" />
        <div className="card-title">修改密码</div>
        <div className="card-sub">必须先输入当前密码；修改成功后，当前页面不会退出</div>
        <div className="form-grid" style={{ marginTop: 16 }}>
          <div className="field full">
            <label>当前密码</label>
            <input className="input" type="password" autoComplete="current-password"
              value={pw.old} onChange={(e) => setPw({ ...pw, old: e.target.value })} />
          </div>
          <div className="field">
            <label>新密码（至少 8 位）</label>
            <input className="input" type="password" autoComplete="new-password"
              value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </div>
          <div className="field">
            <label>再输一遍新密码</label>
            <input className="input" type="password" autoComplete="new-password"
              value={pw.next2} onChange={(e) => setPw({ ...pw, next2: e.target.value })} />
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-primary" disabled={saving} onClick={changePassword}>
            <Icon name="edit" size={15} /> {saving ? '修改中…' : '修改密码'}
          </button>
        </div>
      </div>
    </div>
  );
}
