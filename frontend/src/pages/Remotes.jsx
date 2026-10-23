import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { BrandBadge, HelpTip, Icon, Modal } from '../components.jsx';
import { fieldHelp, s3ProviderLabel, typeLabel } from '../fieldhelp.js';
import { fmtAgo, fmtBytes } from '../util.js';

// 文件浏览（#27）：逐级看目录，文件可直接下载回本机（经网关流式转发）；文件夹只能进不能下
function FileBrowser({ remote, onClose }) {
  const root = remote.type === 'local' ? '/' : '';
  const [path, setPath] = useState(root);
  const [dirs, setDirs] = useState([]);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function load(p) {
    setLoading(true); setErr('');
    try {
      const d = await api.get(`/files?remote=${encodeURIComponent(remote.name)}&path=${encodeURIComponent(p)}`);
      setDirs(d.dirs || []); setFiles(d.files || []); setPath(p);
    } catch (e) { setErr(e.message); setDirs([]); setFiles([]); }
    setLoading(false);
  }
  useEffect(() => { load(root); /* eslint-disable-next-line */ }, []);

  const segments = path.split('/').filter(Boolean);
  const isAbs = path.startsWith('/');
  const joinSegs = (n) => (isAbs ? '/' : '') + segments.slice(0, n).join('/');
  const parentPath = segments.length <= 1 ? root : joinSegs(segments.length - 1);
  const dl = (f) => `/api/download?remote=${encodeURIComponent(remote.name)}&path=${encodeURIComponent(f.path)}`;
  return (
    <Modal title={`浏览文件：${remote.name}`} sub="点文件夹进去看；文件点右边「下载」就能取回本机。文件夹不能整个下载" wide onClose={onClose}>
      <div className="crumb-nav">
        <button onClick={() => load(root)}>{remote.name} 根目录</button>
        {segments.map((c, i) => (
          <span key={i}>/ <button onClick={() => load(joinSegs(i + 1))}>{c}</button></span>
        ))}
      </div>
      {err && <div className="login-err">{err}</div>}
      <div className="folder-list">
        {path !== root && (
          <div className="folder-item" onClick={() => load(parentPath)}>
            <Icon name="up" size={15} /> 返回上一级
          </div>
        )}
        {loading && <div className="folder-item" style={{ color: 'var(--text-3)' }}>加载中…</div>}
        {!loading && !err && dirs.length === 0 && files.length === 0 && (
          <div className="folder-item" style={{ color: 'var(--text-3)' }}>（这个文件夹是空的）</div>
        )}
        {!loading && dirs.map((d) => (
          <div className="folder-item" key={d.path} onClick={() => load(d.path)}>
            <span style={{ color: '#e8a13a' }}><Icon name="folder" size={16} /></span>{d.name}
            <span style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 12 }}>文件夹（点进去看）</span>
          </div>
        ))}
        {!loading && files.map((f) => (
          <div className="folder-item" key={f.path} style={{ cursor: 'default' }}>
            <span style={{ color: 'var(--text-3)' }}><Icon name="drive" size={15} /></span>
            <span style={{ wordBreak: 'break-all' }}>{f.name}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 12, whiteSpace: 'nowrap' }}>{f.size != null ? fmtBytes(f.size) : ''}</span>
            <a className="btn btn-ghost btn-sm" href={dl(f)}>下载</a>
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>在这里只能看和下载，不会改动网盘里的任何文件。</div>
    </Modal>
  );
}

function ProviderForm({ providers, onDone, toast, editing }) {
  const [type, setType] = useState(editing?.type || 's3');
  const [name, setName] = useState(editing?.name || '');
  const [values, setValues] = useState({});
  const [secrets, setSecrets] = useState([]);
  const [loaded, setLoaded] = useState(!editing);
  const [showAdv, setShowAdv] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // 编辑：先拉当前配置回填（密码类字段服务端不下发明文，只告诉我们哪些已保存）
  useEffect(() => {
    if (!editing) return;
    api.get(`/remotes/${encodeURIComponent(editing.name)}/config`)
      .then((d) => { setType(d.type || editing.type); setValues(d.config || {}); setSecrets(d.secrets || []); setLoaded(true); })
      .catch((e) => { setErr(e.message); setLoaded(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const def = providers?.[type];
  const options = useMemo(() => {
    if (!def) return [];
    const all = (def.options || []).filter((o) => !o.hide);
    // 同名字段可能按服务商重复定义（如 koofr 的 password 有 koofr/digistorage/other 三份）：
    // 只保留与当前所选服务商匹配的一份（没选时保留无厂商限定的那份，再不行取第一份）
    const byName = new Map();
    for (const o of all) {
      if (!byName.has(o.name)) byName.set(o.name, []);
      byName.get(o.name).push(o);
    }
    const picked = [];
    for (const group of byName.values()) {
      if (group.length === 1) { picked.push(group[0]); continue; }
      picked.push(group.find((o) => o.provider && o.provider === values.provider)
        || group.find((o) => !o.provider) || group[0]);
    }
    // 保持原始顺序
    return all.filter((o) => picked.includes(o));
  }, [def, values.provider]);
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
    // S3 的服务商字段：选项很多，做成带中文名的下拉
    if (type === 's3' && o.name === 'provider' && o.examples && o.examples.length > 0) {
      return (
        <select className="select" value={v} onChange={(e) => set(e.target.value)}>
          <option value="">（请选择服务商）</option>
          {o.examples.map((ex) => <option key={ex.value} value={ex.value}>{s3ProviderLabel(ex.value)}</option>)}
        </select>
      );
    }
    if (o.examples && o.examples.length > 0 && o.examples.length <= 12) {
      return (
        <select className="select" value={v} onChange={(e) => set(e.target.value)}>
          <option value="">（不填）</option>
          {o.examples.map((ex) => <option key={ex.value} value={ex.value}>{ex.value}</option>)}
        </select>
      );
    }
    if (o.type === 'password') {
      const saved = editing && secrets.includes(o.name);
      return <input className="input" type="password" autoComplete="new-password" value={v} onChange={(e) => set(e.target.value)}
        placeholder={saved ? '已保存，留空表示不改' : '填写后将由 rclone 加密保存'} />;
    }
    if (o.type === 'int' || o.type === 'size' || o.type === 'duration') {
      return <input className="input" type="text" inputMode="numeric" value={v} onChange={(e) => set(e.target.value)} placeholder={o.default || ''} />;
    }
    return <input className="input" value={v} onChange={(e) => set(e.target.value)} placeholder={o.default || ''} />;
  }

  function renderOptions(list) {
    return list.map((o) => {
      const help = fieldHelp(type, o.name, values.provider);
      // 没收录进词典的字段：给中文兜底，英文原文只放进问号图标的 title（悬停原生提示）
      const brief = help?.brief || (o.advanced ? '一般不用改（高级选项）' : o.required ? '必填项，按服务商提供的值填写' : '可选，一般可留空');
      return (
        <div className="field" key={o.name + (o.provider || '')}>
          <label>
            {o.name}{o.required ? ' *' : ''} <span className="hint">{brief}</span>{' '}
            <HelpTip text={help?.detail || ''} titleText={help?.detail ? '' : (o.help || '')} />
          </label>
          {field(o)}
        </div>
      );
    });
  }

  async function submit() {
    setErr('');
    if (editing) {
      setSaving(true);
      try {
        const d = await api.put(`/remotes/${encodeURIComponent(editing.name)}/config`, { config: values });
        if (d.test?.ok) toast(`网盘「${editing.name}」已保存，重测连接正常${d.test.remark ? `（${d.test.remark}）` : ''}`);
        else toast(`网盘「${editing.name}」已保存，但重测未通过：${d.test?.cause || ''}`, true);
        onDone();
      } catch (e) { setErr(e.message); }
      setSaving(false);
      return;
    }
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
          <select className="select" value={type} disabled={!!editing} onChange={(e) => { setType(e.target.value); setValues({}); }}>
            {providers && Object.keys(providers).map((t) => (
              <option key={t} value={t}>{typeLabel(t)}</option>
            ))}
          </select>
          {editing && <div className="hint" style={{ marginTop: 4 }}>类型不能改（要换类型请删掉重加）</div>}
        </div>
        <div className="field">
          <label>显示名称 *</label>
          <input className="input" value={name} disabled={!!editing} onChange={(e) => setName(e.target.value)} placeholder="例如：我的 R2、Koofr 备份盘" />
          {editing && <div className="hint" style={{ marginTop: 4 }}>名称不能改（改名会让已有的备份任务找不到它）</div>}
        </div>
      </div>
      {editing && !loaded && <div className="loading-page"><span className="spin" /> 正在读取当前配置…</div>}
      {editing && loaded && secrets.length > 0 && (
        <div className="info-box" style={{ marginTop: 8 }}>
          密码 / 密钥类字段（{secrets.join('、')}）已经保存着了，出于安全不显示原文：<b>留空表示不改</b>，要换就直接填新值。
        </div>
      )}
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
      {type === 'local' && (
        <div className="info-box" style={{ marginTop: 8 }}>
          本地目录指的是面板所在机器（容器）自己的文件夹，一般不用填任何参数，直接添加即可。
          <b>想备份这台服务器上的文件</b>：部署时按文档开启「服务器文件挂载」后，容器里会多出一个 <b>/host</b> 目录——
          那就是服务器整个硬盘的只读视图；建备份任务选文件夹时从 /host 进去挑目录就行。
          <HelpTip text={'怎么开启：在部署目录的 docker-compose.yml 里，把 volumes 下那行被注释掉的「/:/host:ro」取消注释，再执行 docker compose up -d 重建容器（README「备份服务器上的文件」一节有详细步骤）。\n放心：/host 是只读的，备份只会读文件，不会改动或删掉服务器上的任何东西。\n小提示：直接备份 /host 根目录时，proc、sys、dev、run 这些系统虚拟目录会被自动跳过（备了也没用）；更推荐按重要目录（比如 /host/etc、/host/home）分别建任务，恢复时更好找。'} />
        </div>
      )}
      {!def && <div className="loading-page"><span className="spin" /> 正在读取该类型的配置项…</div>}
      {def && loaded && (
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
        <button className="btn btn-primary" disabled={saving || !loaded} onClick={submit}>
          {saving ? '保存中…' : editing ? '保存修改' : '添加网盘'}
        </button>
      </div>
    </div>
  );
}

export default function Remotes({ toast, nav, gotoDetail, openAddSignal, onConsumeAddSignal }) {
  // #32：侧栏「添加网盘」带来的信号——落到本页就打开添加表单，随即回调消费掉，
  // 之后切去别的页再回来、或刷新，都不会重复弹
  useEffect(() => {
    if (openAddSignal) { setAdding(true); onConsumeAddSignal?.(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAddSignal]);
  const [remotes, setRemotes] = useState(null);
  const [providers, setProviders] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [browsing, setBrowsing] = useState(null);
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
  async function togglePause(r) {
    try {
      await api.post(`/remotes/${encodeURIComponent(r.name)}/${r.paused ? 'resume' : 'pause'}`);
      toast(r.paused ? `网盘「${r.name}」已恢复` : `网盘「${r.name}」已暂停（自检跳过、用它的任务会跳过）`);
    } catch (e) { toast(e.message, true); }
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
          <div className="task-row" key={r.name} style={r.paused ? { opacity: 0.82 } : undefined}>
            <BrandBadge remote={r} size={46} />
            <div className="row-main" onClick={() => gotoDetail?.(r.name)} style={{ cursor: 'pointer' }}
              title="点开看这个网盘的详情（状态、容量、同步关系、最近记录）">
              <div style={{ fontWeight: 700, fontSize: 15 }}>{r.name}</div>
              <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>
                类型：{typeLabel(r.type)}
                {r.health?.lastCheckAt && <> · 上次检查 {fmtAgo(r.health.lastCheckAt)}</>}
              </div>
              {r.health?.about?.total
                ? (
                  <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>
                    容量：共 {fmtBytes(r.health.about.total)}，已用 {fmtBytes(r.health.about.used ?? 0)}
                    {r.health.about.free != null && <>，剩余 {fmtBytes(r.health.about.free)}</>}
                    {r.health.usedPercent != null && <>（已用 {r.health.usedPercent}%）</>}
                  </div>
                )
                : r.health?.lastCheckAt
                  ? <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>容量：未知（这个网盘不支持查询容量）</div>
                  : null}
              {r.health?.remark && (
                <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>{r.health.remark}</div>
              )}
            </div>
            <div className="row-actions">
              {r.needsCredentials && <span className="pill pill-run">待补填凭证</span>}
              {r.paused && <span className="pill pill-off">已暂停</span>}
              {!r.paused && r.health?.status === 'down' && <span className="pill pill-fail">✕ 连接失效</span>}
              {!r.paused && r.health?.status === 'retrying' && <span className="pill pill-run">连接异常</span>}
              {!r.paused && r.health?.status === 'ok' && <span className="pill pill-ok">✓ 连接正常</span>}
              <button className="btn btn-ghost btn-sm" onClick={() => gotoDetail?.(r.name)}>
                <Icon name="drive" size={13} /> 详情
              </button>
              <button className="btn btn-ghost btn-sm" disabled={testing === r.name} onClick={() => test(r)}>
                <Icon name="refresh" size={13} /> {testing === r.name ? '测试中…' : '测试连接'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setBrowsing(r)}>
                <Icon name="folder" size={13} /> 浏览文件
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(r)}>
                <Icon name="edit" size={13} /> 编辑
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => togglePause(r)}>
                <Icon name={r.paused ? 'play' : 'pause'} size={13} /> {r.paused ? '恢复' : '暂停'}
              </button>
              <button className="btn-link" onClick={() => nav('tasks')}>建备份任务</button>
              <button className="btn-link danger" onClick={() => remove(r)}>删除</button>
            </div>
          </div>
        ))}
      </div>

      {adding && (
        <Modal title="添加网盘" sub="配置项由 rclone 官方定义，密码类字段会被加密保存" wide onClose={() => setAdding(false)}>
          <ProviderForm providers={providers} toast={toast} onDone={() => { setAdding(false); load(); }} />
        </Modal>
      )}
      {editing && (
        <Modal title={`编辑网盘「${editing.name}」`} sub="核对或修改配置；密码类字段留空表示不改，保存后会自动重测连接" wide onClose={() => setEditing(null)}>
          <ProviderForm providers={providers} toast={toast} editing={editing} onDone={() => { setEditing(null); load(); }} />
        </Modal>
      )}
      {browsing && <FileBrowser remote={browsing} onClose={() => setBrowsing(null)} />}
    </div>
  );
}
