import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { FolderPicker, Icon, Modal, HelpTip } from '../components.jsx';
import { fmtAgo, fmtTime, scheduleText, WEEKDAYS } from '../util.js';

const FILTER_ACTIONS = [
  { value: 'exclude', label: '排除' },
  { value: 'include', label: '仅同步' }
];
const FILTER_TARGETS = [
  { value: 'any', label: '不限对象' },
  { value: 'file', label: '文件' },
  { value: 'folder', label: '文件夹' }
];
const FILTER_MATCHES = [
  { value: 'contains', label: '名字包含' },
  { value: 'exact', label: '名字等于' },
  { value: 'ext', label: '扩展名' },
  { value: 'glob', label: '通配符' }
];
const FILTER_LABEL = (list, value) => list.find((x) => x.value === value)?.label || value;

export function filterPreview(f) {
  const raw = String(f?.value || '').trim();
  const shown = f?.match === 'ext' ? `.${raw.replace(/^\.+/, '')}` : (raw || '（未填写）');
  const matchText = f?.match === 'contains' ? `名字包含 ${shown}`
    : f?.match === 'exact' ? `名字等于 ${shown}`
    : f?.match === 'ext' ? `扩展名 ${shown}`
    : `通配符 ${shown}`;
  return `${FILTER_LABEL(FILTER_ACTIONS, f?.action)} · ${FILTER_LABEL(FILTER_TARGETS, f?.target)} · ${matchText}`;
}

function filterPlaceholder(f) {
  if (f.match === 'ext') return '例如 zip 或 .zip';
  if (f.match === 'glob') return '例如 docs/*.txt 或 cache-*';
  if (f.match === 'exact') return '例如 report';
  return '例如 cache';
}

const cleanPairFilters = (filters) => (Array.isArray(filters)
  ? filters.map((f) => ({
    action: f?.action || 'exclude',
    target: f?.target || 'any',
    match: f?.match || 'contains',
    value: f?.value || ''
  }))
  : []);

function TaskForm({ remotes, initial, onDone, toast }) {
  const [name, setName] = useState(initial?.name || '');
  const [srcRemote, setSrcRemote] = useState(initial?.srcRemote || '');
  const [dstRemote, setDstRemote] = useState(initial?.dstRemote || '');
  // #25：文件夹映射列表（源网盘、目标网盘是任务级的；每组各选一个源文件夹与目标文件夹）
  const [pairs, setPairs] = useState(() => {
    if (initial?.pairs && initial.pairs.length) {
      return initial.pairs.map((x) => {
        const filters = cleanPairFilters(x.filters);
        return { src: x.src || '', dst: x.dst || '', filters, filtersOpen: filters.length > 0 };
      });
    }
    return [{ src: initial?.srcPath || '', dst: initial?.dstPath || '', filters: [], filtersOpen: false }];
  });
  const [picking, setPicking] = useState(null); // { idx, side: 'src' | 'dst' }
  const s0 = initial?.schedule || {};
  const [schedType, setSchedType] = useState(s0.type || 'daily');
  const [time, setTime] = useState(s0.time || '03:30');
  const [weekdays, setWeekdays] = useState(
    s0.weekdays && s0.weekdays.length ? s0.weekdays : (s0.weekday != null ? [s0.weekday] : [1]));
  const [dayOfMonth, setDayOfMonth] = useState(s0.dayOfMonth ?? 1);
  const [intervalHours, setIntervalHours] = useState(s0.intervalHours ?? 6);
  const [intervalDays, setIntervalDays] = useState(s0.intervalDays ?? 3);
  const [cron, setCron] = useState(s0.cron || '30 3 * * *');
  // #27：任务级高级选项。老任务没有这些字段时：编辑保持「全关/不限」的现状；
  // 全新任务则给推荐默认（安全阀 100 个 / 30%，其余关），用户可改可关。
  const isNew = !initial?.id;
  const [verOn, setVerOn] = useState(!!initial?.versioning?.enabled);
  const [keepDays, setKeepDays] = useState(initial?.versioning?.keepDays ?? 30);
  const [mdCount, setMdCount] = useState(initial?.maxDelete ? (initial.maxDelete.count ?? 0) : (isNew ? 100 : 0));
  const [mdPercent, setMdPercent] = useState(initial?.maxDelete ? (initial.maxDelete.percent ?? 0) : (isNew ? 30 : 0));
  const [bwlimit, setBwlimit] = useState(initial?.bwlimit || '');
  const [trackRenames, setTrackRenames] = useState(!!initial?.trackRenames);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  function toggleWeekday(d) {
    setWeekdays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b));
  }
  function setPairPath(idx, side, path) {
    setPairs((prev) => prev.map((x, i) => (i === idx ? { ...x, [side]: path } : x)));
  }
  function updatePairFilters(idx, updater) {
    setPairs((prev) => prev.map((x, i) => (i === idx ? { ...x, filters: updater(x.filters || []) } : x)));
  }
  function addFilter(idx) {
    updatePairFilters(idx, (filters) => [...filters, { action: 'exclude', target: 'any', match: 'contains', value: '' }]);
    setPairs((prev) => prev.map((x, i) => (i === idx ? { ...x, filtersOpen: true } : x)));
  }
  function updateFilter(idx, filterIdx, patch) {
    updatePairFilters(idx, (filters) => filters.map((f, j) => (j === filterIdx ? { ...f, ...patch } : f)));
  }
  function removeFilter(idx, filterIdx) {
    updatePairFilters(idx, (filters) => filters.filter((_, j) => j !== filterIdx));
  }
  function changeRemote(side, value) {
    // 换了网盘，原来在旧网盘里选的文件夹路径就不作数了，清掉这一侧全部组的选择
    if (side === 'src') { setSrcRemote(value); setPairs((prev) => prev.map((x) => ({ ...x, src: '' }))); }
    else { setDstRemote(value); setPairs((prev) => prev.map((x) => ({ ...x, dst: '' }))); }
    if (picking && picking.side === side) setPicking(null);
  }

  async function save() {
    setErr('');
    if (!srcRemote || !dstRemote) { setErr('请先选好源网盘和目标网盘'); return; }
    if (!pairs.length) { setErr('至少要有一组文件夹映射'); return; }
    const sameIdx = pairs.findIndex((x) => srcRemote === dstRemote && x.src === x.dst);
    if (sameIdx >= 0) { setErr(`第 ${sameIdx + 1} 组的源和目标是同一个位置，换一个目标文件夹`); return; }
    for (let i = 0; i < pairs.length; i++) {
      const filters = pairs[i].filters || [];
      for (let j = 0; j < filters.length; j++) {
        const f = filters[j];
        if (!String(f.value || '').trim()) { setErr(`第 ${i + 1} 组第 ${j + 1} 条筛选的内容不能为空`); return; }
        if (f.match === 'ext') {
          const ext = String(f.value).trim().replace(/^\.+/, '');
          if (!ext || /[\s/\\*?[\]{}]/.test(ext)) { setErr(`第 ${i + 1} 组第 ${j + 1} 条筛选的扩展名格式不对，请填 zip 或 .zip`); return; }
        }
      }
    }
    if (schedType === 'weekly' && weekdays.length === 0) { setErr('每周方式至少要选一个星期'); return; }
    if (schedType === 'cron' && cron.trim().split(/\s+/).length !== 5) { setErr('cron 表达式要是五段：分 时 日 月 周，例如 30 3 * * *'); return; }
    if (verOn && (!Number.isFinite(Number(keepDays)) || Number(keepDays) < 1 || Number(keepDays) > 3650)) { setErr('旧版本保留天数要在 1 到 3650 之间'); return; }
    if (!Number.isFinite(Number(mdCount)) || Number(mdCount) < 0) { setErr('安全阀的删除文件数上限不能是负数（0 表示不限）'); return; }
    if (!Number.isFinite(Number(mdPercent)) || Number(mdPercent) < 0 || Number(mdPercent) > 100) { setErr('安全阀的删除比例要在 0（不限）到 100 之间'); return; }
    if (bwlimit.trim() && !/^\d+(\.\d+)?\s*[kKmMgGtT]?[bB]?$/.test(bwlimit.trim())) { setErr('限速格式不对：填数字加单位，如 500k（约 500 KB/秒）、5M（约 5 MB/秒）；留空表示不限速'); return; }
    setSaving(true);
    const schedule = { type: schedType, time };
    if (schedType === 'weekly') schedule.weekdays = weekdays;
    if (schedType === 'monthly') schedule.dayOfMonth = Number(dayOfMonth);
    if (schedType === 'hours') schedule.intervalHours = Number(intervalHours);
    if (schedType === 'days') schedule.intervalDays = Number(intervalDays);
    if (schedType === 'cron') schedule.cron = cron.trim();
    const body = {
      name: name.trim() || `${srcRemote} → ${dstRemote}`,
      srcRemote, dstRemote,
      pairs: pairs.map(({ src, dst, filters }) => ({ src, dst, filters: cleanPairFilters(filters) })),
      schedule,
      versioning: { enabled: verOn, keepDays: Number(keepDays) || 30 },
      maxDelete: { count: Math.trunc(Number(mdCount) || 0), percent: Math.trunc(Number(mdPercent) || 0) },
      bwlimit: bwlimit.trim(),
      trackRenames
    };
    try {
      if (initial?.id) await api.put(`/tasks/${initial.id}`, body);
      else await api.post('/tasks', body);
      toast(initial?.id ? '任务已保存' : '备份任务已创建');
      onDone();
    } catch (e) { setErr(e.message); }
    setSaving(false);
  }

  const pathLabel = (path) => (path ? (path.startsWith('/') ? path : '/' + path) : '/（根目录）');
  const pickRemote = picking ? (picking.side === 'src' ? srcRemote : dstRemote) : '';
  const pickRemoteType = (remotes.find((r) => r.name === pickRemote) || {}).type;

  return (
    <div>
      {err && <div className="login-err">{err}</div>}
      <div className="form-grid" style={{ marginBottom: 6 }}>
        <div className="field">
          <label>源网盘</label>
          <select className="select" value={srcRemote} onChange={(e) => changeRemote('src', e.target.value)}>
            <option value="">请选择网盘…</option>
            {remotes.map((r) => <option key={r.name} value={r.name}>{r.name}（{r.type}）</option>)}
          </select>
        </div>
        <div className="field">
          <label>目标网盘</label>
          <select className="select" value={dstRemote} onChange={(e) => changeRemote('dst', e.target.value)}>
            <option value="">请选择网盘…</option>
            {remotes.map((r) => <option key={r.name} value={r.name}>{r.name}（{r.type}）</option>)}
          </select>
        </div>
      </div>

      <div className="field" style={{ marginBottom: 10 }}>
        <label>文件夹映射 <span className="hint">（一个任务可以备多个文件夹：每组选一个源文件夹和它要去的目标文件夹）</span></label>
        {pairs.map((x, i) => (
          <div className="pair-map-block" key={i}>
            <div className="pair-map-row">
              <span className="pair-map-no">第 {i + 1} 组</span>
              <button type="button" className="pair-map-cell" title="点这里选源文件夹"
                onClick={() => setPicking({ idx: i, side: 'src' })}>
                <span className="pair-map-tag">源</span>{pathLabel(x.src)}
              </button>
              <span className="pair-map-arrow">→</span>
              <button type="button" className="pair-map-cell" title="点这里选目标文件夹"
                onClick={() => setPicking({ idx: i, side: 'dst' })}>
                <span className="pair-map-tag">目标</span>{pathLabel(x.dst)}
              </button>
              <button type="button" className="btn-link danger" disabled={pairs.length <= 1}
                title={pairs.length <= 1 ? '至少保留一组' : '删掉这一组'}
                onClick={() => { setPairs((prev) => prev.filter((_, j) => j !== i)); setPicking(null); }}>删除</button>
            </div>
            <div className="pair-filter-bar">
              <button type="button" className="btn-link" aria-expanded={!!x.filtersOpen}
                onClick={() => setPairs((prev) => prev.map((p, j) => (j === i ? { ...p, filtersOpen: !p.filtersOpen } : p)))}>
                筛选{x.filters?.length ? `（${x.filters.length} 条）` : ''} {x.filtersOpen ? '收起' : '展开'}
              </button>
              <span>{x.filters?.length ? '已设置筛选' : '无筛选（全部同步）'}</span>
            </div>
            {x.filtersOpen && (
              <div className="pair-filter-editor">
                {(x.filters || []).map((f, fi) => (
                  <div className="filter-rule-row" key={fi}>
                    <select className="select" aria-label="筛选作用" value={f.action}
                      onChange={(e) => updateFilter(i, fi, { action: e.target.value })}>
                      {FILTER_ACTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <select className="select" aria-label="筛选对象" value={f.target}
                      onChange={(e) => updateFilter(i, fi, { target: e.target.value })}>
                      {FILTER_TARGETS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <select className="select" aria-label="匹配方式" value={f.match}
                      onChange={(e) => updateFilter(i, fi, { match: e.target.value })}>
                      {FILTER_MATCHES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <input className="input" aria-label="筛选内容" value={f.value}
                      placeholder={filterPlaceholder(f)}
                      onChange={(e) => updateFilter(i, fi, { value: e.target.value })} />
                    <button type="button" className="btn-link danger" onClick={() => removeFilter(i, fi)}>删除规则</button>
                    <div className="filter-rule-preview">{filterPreview(f)}</div>
                  </div>
                ))}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => addFilter(i)}>
                  <Icon name="plus" size={14} /> 添加规则
                </button>
              </div>
            )}
          </div>
        ))}
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }}
          onClick={() => setPairs((prev) => [...prev, { src: '', dst: '', filters: [], filtersOpen: false }])}>
          <Icon name="plus" size={14} /> 添加一组
        </button>
      </div>

      {picking && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>
            第 {picking.idx + 1} 组 · 选择{picking.side === 'src' ? '源' : '目标'}文件夹
            <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>（网盘：{pickRemote || '未选择'}）</span>
          </div>
          {pickRemote ? (
            <FolderPicker
              remote={pickRemote}
              remoteType={pickRemoteType}
              value={pairs[picking.idx][picking.side]}
              onChange={(p) => setPairPath(picking.idx, picking.side, p)}
            />
          ) : (
            <div className="login-err">请先在上面选好{picking.side === 'src' ? '源' : '目标'}网盘</div>
          )}
          <div style={{ textAlign: 'right', marginTop: 10 }}>
            <button className="btn btn-primary btn-sm" onClick={() => setPicking(null)}>就选这个文件夹</button>
          </div>
        </div>
      )}

      <div className="form-grid">
        <div className="field full">
          <label>任务名称 <span className="hint">（可选，不填自动生成）</span></label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={srcRemote && dstRemote ? `${srcRemote} → ${dstRemote}` : '例如：R2 备份到 Koofr'} />
        </div>
        <div className="field">
          <label>定时方式</label>
          <select className="select" value={schedType} onChange={(e) => setSchedType(e.target.value)}>
            <option value="daily">每天</option>
            <option value="weekly">每周（可选多天）</option>
            <option value="monthly">每月</option>
            <option value="hours">每隔几小时</option>
            <option value="days">每隔几天</option>
            <option value="cron">高级：cron 表达式</option>
          </select>
        </div>
        <div className="field">
          <label>{schedType === 'hours' ? '间隔' : schedType === 'cron' ? 'cron 表达式' : '执行时间'}</label>
          {schedType === 'weekly' && (
            <div className="wd-chips" style={{ marginBottom: 8 }}>
              {WEEKDAYS.map((w, i) => (
                <button type="button" key={i}
                  className={`wd-chip${weekdays.includes(i) ? ' on' : ''}`}
                  onClick={() => toggleWeekday(i)}>{w.replace('周', '')}</button>
              ))}
            </div>
          )}
          {schedType === 'monthly' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ color: 'var(--text-2)', fontSize: 13 }}>每月</span>
              <input className="input" type="number" min="1" max="31" style={{ width: 84 }}
                value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} />
              <span style={{ color: 'var(--text-2)', fontSize: 13 }}>号（填 31 时，短月份自动按最后一天跑）</span>
            </div>
          )}
          {schedType === 'hours' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ color: 'var(--text-2)', fontSize: 13 }}>每隔</span>
              <input className="input" type="number" min="1" max="720" style={{ width: 84 }}
                value={intervalHours} onChange={(e) => setIntervalHours(e.target.value)} />
              <span style={{ color: 'var(--text-2)', fontSize: 13 }}>小时执行一次（从保存时刻起算）</span>
            </div>
          )}
          {schedType === 'days' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ color: 'var(--text-2)', fontSize: 13 }}>每隔</span>
              <input className="input" type="number" min="1" max="365" style={{ width: 84 }}
                value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} />
              <span style={{ color: 'var(--text-2)', fontSize: 13 }}>天，在下面时间执行一次</span>
            </div>
          )}
          {schedType === 'cron' && (
            <>
              <input className="input" value={cron} onChange={(e) => setCron(e.target.value)}
                placeholder="分 时 日 月 周，例如 30 3 * * *" style={{ fontFamily: 'ui-monospace, Menlo, monospace' }} />
              <div style={{ color: 'var(--text-3)', fontSize: 12.5, marginTop: 6 }}>
                给熟悉 cron 的用户用的高级写法（五段：分 时 日 月 周），不熟悉就用上面几种方式，别改这个。
              </div>
            </>
          )}
          {schedType !== 'hours' && schedType !== 'cron' && (
            <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          )}
        </div>
      </div>
      <div className="adv-box">
        <div className="adv-title">数据安全与高级选项 <span className="hint">（都可不设；老任务默认全关、不限）</span></div>
        <div className="adv-row">
          <label className="adv-check">
            <input type="checkbox" checked={verOn} onChange={(e) => setVerOn(e.target.checked)} />
            旧版本保留
            <HelpTip text="开启后，被覆盖或被删除的文件不会直接消失：先移进目标文件夹里的 .rclona-archive/日期 归档区，保留若干天后自动清理。误删、源被清空时能从归档里捞回来。归档区不在镜像范围内、不会被同步删掉；代价是多占一点目标空间。" />
          </label>
          {verOn && (
            <span className="adv-inline">保留
              <input className="input" type="number" min="1" max="3650" style={{ width: 84 }} value={keepDays}
                onChange={(e) => setKeepDays(e.target.value)} /> 天
            </span>
          )}
        </div>
        <div className="adv-row">
          <span className="adv-label">删除安全阀
            <HelpTip text="防误删的保险：如果一次备份要删掉的文件超过上限，就直接中止并给你发 Telegram 通知，一个文件都不会删。两个上限哪个先到都算触发；填 0 表示这一项不限。比如源被某个 App 清空、或路径配错时，它能拦住「把目标的好副本也删光」。" />
          </span>
          <span className="adv-inline">最多删
            <input className="input" type="number" min="0" style={{ width: 96 }} value={mdCount}
              onChange={(e) => setMdCount(e.target.value)} /> 个文件，
          </span>
          <span className="adv-inline">或超过目标现有文件的
            <input className="input" type="number" min="0" max="100" style={{ width: 76 }} value={mdPercent}
              onChange={(e) => setMdPercent(e.target.value)} /> %
          </span>
        </div>
        <div className="adv-row">
          <span className="adv-label">同步限速
            <HelpTip text="限制这个任务同步时的最高速度，保护服务器带宽和弱网。写法：数字+单位，如 500k（约 500 KB/秒）、5M（约 5 MB/秒）；留空不限速。注意：面板全局共用一个限速开关，两个任务同时跑时以正在同步的那个为准。" />
          </span>
          <input className="input" style={{ width: 170 }} value={bwlimit} placeholder="留空不限，如 5M"
            onChange={(e) => setBwlimit(e.target.value)} />
        </div>
        <div className="adv-row">
          <label className="adv-check">
            <input type="checkbox" checked={trackRenames} onChange={(e) => setTrackRenames(e.target.checked)} />
            改名识别（不重传）
            <HelpTip text="开启后，源里改了名的文件会在目标里直接改名，不重新上传一份，适合经常改名的文件夹。代价：每次同步要多一轮指纹比对；目标网盘不支持时会自动退回重传，不影响备份结果。" />
          </label>
        </div>
      </div>
      <div className="note-box" style={{ marginTop: 16 }}>
        同步方式为<strong>纯镜像</strong>：目标网盘会与源保持完全一致 —— 源里新增/修改的文件会同步过去，
        <strong>源里删除的文件，目标里也会被删除</strong>。比对使用校验和，改过的文件不会漏传。
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
        <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存任务'}</button>
      </div>
    </div>
  );
}

function PreviewList({ title, color, files }) {
  if (!files?.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color }}>{title}（{files.length}）</div>
      <div className="pv-list">
        {files.map((f) => <div key={f} className="pv-item">{f}</div>)}
      </div>
    </div>
  );
}

export default function Tasks({ toast }) {
  const [tasks, setTasks] = useState(null);
  const [remotes, setRemotes] = useState([]);
  const [editing, setEditing] = useState(undefined); // undefined=关, null=新建, obj=编辑
  const [runningId, setRunningId] = useState('');
  const [preview, setPreview] = useState(null); // { task, loading, data, error }

  async function load() {
    try {
      const [t, r] = await Promise.all([api.get('/tasks'), api.get('/remotes')]);
      setTasks(t.tasks); setRemotes(r.remotes);
    } catch { setTasks([]); }
  }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);

  async function toggle(task) {
    await api.post(`/tasks/${task.id}/toggle`);
    load();
  }
  async function remove(task) {
    if (!confirm(`确定删除备份任务「${task.name}」吗？（已备份的文件不会被删）`)) return;
    await api.del(`/tasks/${task.id}`);
    toast('任务已删除');
    load();
  }
  async function runNow(task) {
    setRunningId(task.id);
    try {
      await api.post(`/tasks/${task.id}/run`);
      toast('已开始备份，跑完会在右下角通知你');
    } catch (e) { toast(e.message, true); }
    setRunningId('');
    load();
  }
  async function runPreview(task) {
    setPreview({ task, loading: true, data: null, error: '' });
    try {
      const d = await api.post(`/tasks/${task.id}/preview`);
      setPreview({ task, loading: false, data: d.preview, error: '' });
    } catch (e) {
      setPreview({ task, loading: false, data: null, error: e.message });
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">备份任务</div>
          <div className="page-sub">把哪个网盘备份到哪个网盘、什么时候备，都在这里</div>
        </div>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setEditing(null)}><Icon name="plus" size={16} /> 新建备份任务</button>
      </div>
      <div className="card">
        {tasks === null && <div className="loading-page"><span className="spin" /> 加载中…</div>}
        {tasks !== null && tasks.length === 0 && (
          <div className="empty">
            <div className="e-ico"><Icon name="sync" size={40} /></div>
            还没有备份任务，点右上角「新建备份任务」开始。
          </div>
        )}
        {(tasks || []).map((t) => (
          <div className="task-row" key={t.id}>
            <div className="task-ico"><Icon name="sync" size={23} /></div>
            <div className="row-main">
              <div style={{ fontWeight: 700, fontSize: 15 }}>{t.name}</div>
              <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
                从 <b>{t.srcRemote}</b>{(t.pairs?.[0]?.src ?? t.srcPath) ? '/' + (t.pairs?.[0]?.src ?? t.srcPath) : ''} → 到 <b>{t.dstRemote}</b>{(t.pairs?.[0]?.dst ?? t.dstPath) ? '/' + (t.pairs?.[0]?.dst ?? t.dstPath) : ''}
                {t.pairs && t.pairs.length > 1 && <> · <span style={{ color: 'var(--indigo-600)', fontWeight: 600 }}>共 {t.pairs.length} 组文件夹</span></>}
              </div>
              <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>
                {scheduleText(t.schedule)}
                {t.enabled && t.nextRunAt && t.lastStatus !== 'running' && <> · 下次执行 {fmtTime(t.nextRunAt)}</>}
                {t.enabled && !t.nextRunAt && t.lastStatus !== 'running' && <> · <span style={{ color: '#b97d1e' }}>近期无执行时间，请检查计划设置</span></>}
                {t.lastStatus === 'success' && <> · 上次成功 {fmtAgo(t.lastRunAt)}</>}
                {t.lastStatus === 'failed' && <> · <span style={{ color: 'var(--red-dark)' }}>上次失败 {fmtAgo(t.lastRunAt)}</span></>}
                {t.lastStatus === 'skipped' && <> · 上次已跳过（网盘暂停中）</>}
                {t.lastStatus === 'running' && <> · <span style={{ color: 'var(--indigo-600)' }}>正在执行…</span></>}
                {!t.lastStatus && <> · 尚未执行</>}
              </div>
            </div>
            <div className="row-actions">
              {t.lastStatus === 'running'
                ? <span className="pill pill-run">备份中…</span>
                : t.enabled ? <span className="pill pill-ok">已启用</span> : <span className="pill pill-off">已停用</span>}
              <label className="switch" title={t.enabled ? '停用' : '启用'}>
                <input type="checkbox" checked={t.enabled} onChange={() => toggle(t)} />
                <span className="track" />
              </label>
              <button className="btn btn-ghost btn-sm" disabled={t.lastStatus === 'running'} onClick={() => runPreview(t)}>
                试运行
              </button>
              <button className="btn btn-primary btn-sm" disabled={runningId === t.id || t.lastStatus === 'running'} onClick={() => runNow(t)}>
                {t.lastStatus === 'running'
                  ? <><span className="spin" style={{ width: 13, height: 13, borderWidth: 2 }} /> 执行中…</>
                  : <><Icon name="play" size={13} /> 立即执行</>}
              </button>
              <button className="btn-link" onClick={() => setEditing(t)}>编辑</button>
              <button className="btn-link danger" onClick={() => remove(t)}>删除</button>
            </div>
          </div>
        ))}
      </div>

      {editing !== undefined && (
        <Modal title={editing ? '编辑备份任务' : '新建备份任务'} sub="选好源和目标，再定个时间，剩下的交给它" wide onClose={() => setEditing(undefined)}>
          <TaskForm remotes={remotes} initial={editing} toast={toast}
            onDone={() => { setEditing(undefined); load(); }} />
        </Modal>
      )}

      {preview && (
        <Modal title={`试运行：${preview.task.name}`} sub="只比对、不动任何文件：下面是现在真跑一次将会发生的变化" wide onClose={() => setPreview(null)}>
          {preview.loading && <div className="loading-page"><span className="spin" /> 正在比对两边文件…</div>}
          {preview.error && <div className="login-err">{preview.error}</div>}
          {preview.data && preview.data.pairs.map((p, i) => (
            <div key={i} style={{ marginBottom: 18 }}>
              <div style={{ fontWeight: 700, fontSize: 14.5, wordBreak: 'break-all' }}>
                {preview.data.pairs.length > 1 ? `第 ${i + 1} 组：` : ''}{p.src} → {p.dst}
              </div>
              {p.error ? (
                <div style={{ color: 'var(--red-dark)', fontSize: 13.5, marginTop: 6 }}>这一组比对失败：{p.error}</div>
              ) : (
                <>
                  <div style={{ fontSize: 13.5, color: 'var(--text-2)', marginTop: 4 }}>
                    将新增 <b>{p.counts.added}</b> 个 · 将更新 <b>{p.counts.updated}</b> 个 · 将删除 <b style={{ color: 'var(--red-dark)' }}>{p.counts.deleted}</b> 个
                    {p.counts.added + p.counts.updated + p.counts.deleted === 0 && '（两边已经一致，真跑也不会动任何文件）'}
                  </div>
                  <PreviewList title="将新增" color="var(--green-dark, #1d7a3a)" files={p.added} />
                  <PreviewList title="将更新" color="#b97d1e" files={p.updated} />
                  <PreviewList title="将删除" color="var(--red-dark)" files={p.deleted} />
                  {p.truncated && <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 6 }}>清单太长，每类只显示前 200 条，计数是全量。</div>}
                </>
              )}
            </div>
          ))}
          {preview.data && (
            <div className="note-box">试运行只是预演：没有改动目标网盘的任何文件，也不会留下运行记录。确认清单没问题，再点「立即执行」真跑。</div>
          )}
        </Modal>
      )}
    </div>
  );
}
