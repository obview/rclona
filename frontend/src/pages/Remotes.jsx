import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { BrandBadge, Icon, Modal } from '../components.jsx';
import { fmtAgo } from '../util.js';

const TYPE_LABELS = { s3: 'S3 / 对象存储', koofr: 'Koofr', webdav: 'WebDAV', local: '本地目录' };

function ProviderForm({ providers, onDone, toast }) {
  const [type, setType] = useState('s3');
  const [name, setName] = useState('');
  const [values, setValues] = useState({});
  const [showAdv, setShowAdv] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const def = providers?.[type];
  const options = useMemo(() => {
    if (!def) return [];
    return (def.options || []).filter((o) => !o.hide);
  }, [def]);
  const basic = options.filter((o) => !o.advanced);
  const adv = options.filter((o) => o.advanced);

  function field(o) {
    const v = values[o.name] ?? (o.default ?? '');
    const set = (nv) => setValues((s) => ({ ...s, [o.name]: nv }));
    if (o.type === 'bool') {
      return (
        <select className="select" value={String(v === true || v === 'true')} onChange={(e) => set(e.target.value === 'true')}>
          <option value="false">否</option><option value="true">是</option>
        </select>
      );
    }
    if (o.examples && o.examples.length > 0 && o.examples.length <= 12) {
      return (
        <select className="select" value={v} onChange={(e) => set(e.target.value)}>
          <option value="">（不填）</option>
          {o.examples.map((ex) => <option key={ex.value} value={ex.value}>{ex.value}{ex.help ? ` — ${ex.help}` : ''}</option>)}
        </select>
      );
    }
    if (o.type === 'password') {
      return <input className="input" type="password" autoComplete="new-password" value={v} onChange={(e) => set(e.target.value)} placeholder="填写后将由 rclone 加密保存" />;
    }
    if (o.type === 'int' || o.type === 'size' || o.type === 'duration') {
      return <input className="input" type="text" inputMode="numeric" value={v} onChange={(e) => set(e.target.value)} placeholder={o.default || ''} />;
    }
    return <input className="input" value={v} onChange={(e) => set(e.target.value)} placeholder={o.default || ''} />;
  }

  function renderOptions(list) {
    return list.map((o) => (
      <div className="field" key={o.name}>
        <label>{o.name}{o.required ? ' *' : ''} <span className="hint">{o.help ? o.help.split('\n')[0].slice(0, 90) : ''}</span></label>
        {field(o)}
      </div>
    ));
  }

  async function submit() {
    setErr('');
    if (!name.trim()) { setErr('给这个网盘起个名字'); return; }
    if (!/^[A-Za-z0-9_.\-]+$/.test(name.trim())) { setErr('名字只能用英文字母、数字、下划线和横线'); return; }
    setSaving(true);
    try {
      await api.post('/remotes', { name: name.trim(), type, config: values });
      toast(`网盘「${name.trim()}」已添加`);
      onDone();
    } catch (e) { setErr(e.message); }
    setSaving(false);
  }

  return (
    <div>
      {err && <div className="login-err">{err}</div>}
      <div className="form-grid" style={{ marginBottom: 6 }}>
        <div className="field">
          <label>网盘类型</label>
          <select className="select" value={type} onChange={(e) => { setType(e.target.value); setValues({}); }}>
            {providers && Object.keys(providers).map((t) => (
              <option key={t} value={t}>{TYPE_LABELS[t] || t}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>显示名称 *</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：我的 R2、Koofr 备份盘" />
        </div>
      </div>
      {type === 's3' && (
        <div style={{ display: 'flex', gap: 8, margin: '8px 0 4px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--text-2)', alignSelf: 'center' }}>快捷预设：</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setValues((s) => ({ ...s, provider: 'Cloudflare' }))}>Cloudflare R2</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setValues((s) => ({ ...s, provider: 'AWS' }))}>Amazon S3</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setValues((s) => ({ ...s, provider: 'Other' }))}>其他 S3 兼容存储</button>
        </div>
      )}
      {type === 's3' && values.provider === 'Cloudflare' && (
        <div className="info-box" style={{ marginTop: 8 }}>
          R2 提示：endpoint 填 <b>https://&lt;你的账户ID&gt;.r2.cloudflarestorage.com</b>；Access Key 与 Secret 用 R2 令牌里的一对；
          区域（region）留空即可。添加后建议在任务里把「桶名」当作文件夹选进去。
        </div>
      )}
      {type === 'koofr' && (
        <div className="info-box" style={{ marginTop: 8 }}>
          Koofr 提示：密码处不要填登录密码，请到 Koofr 网站「设置 → 安全 → 应用密码」生成一个专用密码再填到这里。
        </div>
      )}
      {!def && <div className="loading-page"><span className="spin" /> 正在读取该类型的配置项…</div>}
      {def && (
        <>
          <div className="form-grid" style={{ marginTop: 10 }}>{renderOptions(basic)}</div>
          {adv.length > 0 && (
            <>
              <button className="btn-link" style={{ marginTop: 10 }} onClick={() => setShowAdv(!showAdv)}>
                {showAdv ? '收起高级选项' : `高级选项（${adv.length} 项，一般不用改）`}
              </button>
              {showAdv && <div className="form-grid" style={{ marginTop: 6 }}>{renderOptions(adv)}</div>}
            </>
          )}
        </>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn btn-primary" disabled={saving} onClick={submit}>{saving ? '添加中…' : '添加网盘'}</button>
      </div>
    </div>
  );
}

export default function Remotes({ toast, nav }) {
  const [remotes, setRemotes] = useState(null);
  const [providers, setProviders] = useState(null);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState('');

  async function load() {
    try {
      const d = await api.get('/remotes');
      setRemotes(d.remotes);
    } catch { setRemotes([]); }
  }
  useEffect(() => {
    load();
    api.get('/remotes/providers').then((d) => setProviders(d.providers)).catch(() => setProviders({}));
  }, []);

  async function test(r) {
    setTesting(r.name);
    try {
      const d = await api.post(`/remotes/${encodeURIComponent(r.name)}/test`);
      toast(d.ok ? `「${r.name}」连接正常` : `「${r.name}」连接失败：${d.cause || ''}`, !d.ok);
    } catch (e) { toast(e.message, true); }
    setTesting('');
    load();
  }
  async function remove(r) {
    if (!confirm(`确定删除网盘「${r.name}」吗？引用它的备份任务将无法执行。`)) return;
    await api.del(`/remotes/${encodeURIComponent(r.name)}`);
    toast('网盘已删除');
    load();
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">网盘管理</div>
          <div className="page-sub">先把网盘加进来，备份任务才能选它们；凭证由 rclone 加密保存</div>
        </div>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> 添加网盘</button>
      </div>
      <div className="card">
        {remotes === null && <div className="loading-page"><span className="spin" /> 加载中…</div>}
        {remotes !== null && remotes.length === 0 && (
          <div className="empty">
            <div className="e-ico"><Icon name="drive" size={40} /></div>
            还没有网盘，点右上角添加你的第一个网盘（例如 Cloudflare R2 或 Koofr）。
          </div>
        )}
        {(remotes || []).map((r) => (
          <div className="task-row" key={r.name}>
            <BrandBadge remote={r} size={46} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{r.name}</div>
              <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>
                类型：{TYPE_LABELS[r.type] || r.type}
                {r.health?.lastCheckAt && <> · 上次检查 {fmtAgo(r.health.lastCheckAt)}</>}
              </div>
            </div>
            {r.health?.status === 'down' && <span className="pill pill-fail">✕ 连接失效</span>}
            {r.health?.status === 'retrying' && <span className="pill pill-run">连接异常</span>}
            {r.health?.status === 'ok' && <span className="pill pill-ok">✓ 连接正常</span>}
            <button className="btn btn-ghost btn-sm" disabled={testing === r.name} onClick={() => test(r)}>
              <Icon name="refresh" size={13} /> {testing === r.name ? '测试中…' : '测试连接'}
            </button>
            <button className="btn-link" onClick={() => nav('tasks')}>建备份任务</button>
            <button className="btn-link danger" onClick={() => remove(r)}>删除</button>
          </div>
        ))}
      </div>

      {adding && (
        <Modal title="添加网盘" sub="配置项由 rclone 官方定义，密码类字段会被加密保存" wide onClose={() => setAdding(false)}>
          <ProviderForm providers={providers} toast={toast} onDone={() => { setAdding(false); load(); }} />
        </Modal>
      )}
    </div>
  );
}
