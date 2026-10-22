import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../components.jsx';

export default function Settings({ toast }) {
  const [s, setS] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [pw, setPw] = useState({ old: '', next: '', next2: '' });

  useEffect(() => {
    api.get('/settings').then((d) => setS(d.settings)).catch(() => setS({}));
  }, []);

  if (!s) return <div className="loading-page"><span className="spin" /> 加载中…</div>;
  const notify = s.notify || {};
  const smtp = s.smtp || {};
  const setNotify = (k, v) => setS((x) => ({ ...x, notify: { ...x.notify, [k]: v } }));
  const setSmtp = (k, v) => setS((x) => ({ ...x, smtp: { ...x.smtp, [k]: v } }));

  async function save() {
    setSaving(true);
    try { await api.put('/settings', s); toast('设置已保存'); }
    catch (e) { toast(e.message, true); }
    setSaving(false);
  }
  async function testEmail() {
    setTesting(true);
    try {
      await api.put('/settings', s);
      await api.post('/settings/test-email');
      toast('测试邮件已发出，请查收');
    } catch (e) { toast(e.message, true); }
    setTesting(false);
  }
  async function changePw() {
    if (pw.next.length < 8) { toast('新密码至少 8 位', true); return; }
    if (pw.next !== pw.next2) { toast('两次输入的新密码不一致', true); return; }
    try {
      await api.post('/auth/password', { oldPassword: pw.old, newPassword: pw.next });
      toast('密码已修改');
      setPw({ old: '', next: '', next2: '' });
    } catch (e) { toast(e.message, true); }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">设置</div>
          <div className="page-sub">失败通知与账号安全</div>
        </div>
        <div className="spacer" />
        <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存设置'}</button>
      </div>

      <div className="card card-pad section-gap">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="card-title">失败邮件通知</div>
            <div className="card-sub">备份失败、网盘连接失效时，立即发邮件告诉你（附失败阶段与原因）</div>
          </div>
          <label className="switch">
            <input type="checkbox" checked={!!notify.enabled} onChange={(e) => setNotify('enabled', e.target.checked)} />
            <span className="track" />
          </label>
        </div>
        {notify.enabled && (
          <>
            <div className="form-grid" style={{ marginTop: 16 }}>
              <div className="field">
                <label>收件邮箱 *</label>
                <input className="input" value={notify.to || ''} onChange={(e) => setNotify('to', e.target.value)} placeholder="你接收通知的邮箱" />
              </div>
              <div className="field">
                <label>SMTP 服务器 *</label>
                <input className="input" value={smtp.host || ''} onChange={(e) => setSmtp('host', e.target.value)} placeholder="例如 smtp.qq.com" />
              </div>
              <div className="field">
                <label>SMTP 端口</label>
                <input className="input" value={smtp.port ?? 465} onChange={(e) => setSmtp('port', Number(e.target.value) || 465)} />
              </div>
              <div className="field">
                <label>加密方式</label>
                <select className="select" value={smtp.secure === false ? 'starttls' : 'ssl'} onChange={(e) => setSmtp('secure', e.target.value === 'ssl')}>
                  <option value="ssl">SSL（端口 465 常用）</option>
                  <option value="starttls">STARTTLS（端口 587 常用）</option>
                </select>
              </div>
              <div className="field">
                <label>发件邮箱账号 *</label>
                <input className="input" value={smtp.user || ''} onChange={(e) => setSmtp('user', e.target.value)} placeholder="发件邮箱地址" />
              </div>
              <div className="field">
                <label>邮箱授权码 * <span className="hint">不是登录密码，在邮箱设置里生成</span></label>
                <input className="input" type="password" value={smtp.pass || ''} onChange={(e) => setSmtp('pass', e.target.value)} placeholder="SMTP 授权码" />
              </div>
            </div>
            <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn btn-ghost btn-sm" disabled={testing} onClick={testEmail}>
                <Icon name="bell" size={14} /> {testing ? '发送中…' : '先存并发送测试邮件'}
              </button>
              <span style={{ color: 'var(--text-3)', fontSize: 12.5 }}>以 QQ 邮箱为例：设置 → 账号 → 开启 SMTP 服务后生成授权码。</span>
            </div>
          </>
        )}
      </div>

      <div className="card card-pad">
        <div className="card-title">修改登录密码</div>
        <div className="card-sub">改完后请用新密码重新登录其他设备</div>
        <div className="form-grid" style={{ marginTop: 14 }}>
          <div className="field">
            <label>当前密码</label>
            <input className="input" type="password" value={pw.old} onChange={(e) => setPw({ ...pw, old: e.target.value })} />
          </div>
          <div className="field">
            <label>新密码（至少 8 位）</label>
            <input className="input" type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </div>
          <div className="field">
            <label>再输一遍新密码</label>
            <input className="input" type="password" value={pw.next2} onChange={(e) => setPw({ ...pw, next2: e.target.value })} />
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={changePw}>修改密码</button>
        </div>
      </div>
    </div>
  );
}
