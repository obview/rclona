import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { BrandBadge, FolderPicker, Icon, Modal } from '../components.jsx';
import { fmtAgo, fmtTime, scheduleText, WEEKDAYS } from '../util.js';

function TaskForm({ remotes, initial, onDone, toast }) {
  const [name, setName] = useState(initial?.name || '');
  const [srcRemote, setSrcRemote] = useState(initial?.srcRemote || '');
  const [srcPath, setSrcPath] = useState(initial?.srcPath || '');
  const [dstRemote, setDstRemote] = useState(initial?.dstRemote || '');
  const [dstPath, setDstPath] = useState(initial?.dstPath || '');
  const [picking, setPicking] = useState(''); // 'src' | 'dst' | ''
  const s0 = initial?.schedule || {};
  const [schedType, setSchedType] = useState(s0.type || 'daily');
  const [time, setTime] = useState(s0.time || '03:30');
  const [weekdays, setWeekdays] = useState(
    s0.weekdays && s0.weekdays.length ? s0.weekdays : (s0.weekday != null ? [s0.weekday] : [1]));
  const [dayOfMonth, setDayOfMonth] = useState(s0.dayOfMonth ?? 1);
  const [intervalHours, setIntervalHours] = useState(s0.intervalHours ?? 6);
  const [intervalDays, setIntervalDays] = useState(s0.intervalDays ?? 3);
  const [cron, setCron] = useState(s0.cron || '30 3 * * *');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const srcR = remotes.find((r) => r.name === srcRemote);
  const dstR = remotes.find((r) => r.name === dstRemote);

  function toggleWeekday(d) {
    setWeekdays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b));
  }

  async function save() {
    setErr('');
    if (!srcRemote || !dstRemote) { setErr('请先选好源网盘和目标网盘'); return; }
    if (srcRemote === dstRemote && srcPath === dstPath) { setErr('源和目标不能是同一个位置'); return; }
    if (schedType === 'weekly' && weekdays.length === 0) { setErr('每周方式至少要选一个星期'); return; }
    if (schedType === 'cron' && cron.trim().split(/\s+/).length !== 5) { setErr('cron 表达式要是五段：分 时 日 月 周，例如 30 3 * * *'); return; }
    setSaving(true);
    const schedule = { type: schedType, time };
    if (schedType === 'weekly') schedule.weekdays = weekdays;
    if (schedType === 'monthly') schedule.dayOfMonth = Number(dayOfMonth);
    if (schedType === 'hours') schedule.intervalHours = Number(intervalHours);
    if (schedType === 'days') schedule.intervalDays = Number(intervalDays);
    if (schedType === 'cron') schedule.cron = cron.trim();
    const body = {
      name: name.trim() || `${srcRemote} → ${dstRemote}`,
      srcRemote, srcPath, dstRemote, dstPath, schedule
    };
    try {
      if (initial?.id) await api.put(`/tasks/${initial.id}`, body);
      else await api.post('/tasks', body);
      toast(initial?.id ? '任务已保存' : '备份任务已创建');
      onDone();
    } catch (e) { setErr(e.message); }
    setSaving(false);
  }

  const pickSide = (side, remote, setRemote, path) => (
    <div className={`pick-side${remote ? ' filled' : ''}`} onClick={() => { if (!remote) setPicking(side); }}>
      {remote ? (
        <>
          <BrandBadge remote={remotes.find((r) => r.name === remote)} size={54} />
          <div className="p-name" style={{ fontSize: 15, fontWeight: 600, marginTop: 8 }}>{remote}</div>
          <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>{path ? (path.startsWith('/') ? path : '/' + path) : '/（根目录）'}</div>
          <button className="btn-link" onClick={(e) => { e.stopPropagation(); setPicking(side); }}>重新选择</button>
        </>
      ) : (
        <>
          <div style={{ color: 'var(--indigo-500)' }}><Icon name="plus" size={30} /></div>
          <div style={{ marginTop: 8, fontWeight: 600 }}>{side === 'src' ? '选择源网盘' : '选择目标网盘'}</div>
          <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>点这里挑选网盘与文件夹</div>
        </>
      )}
    </div>
  );

  return (
    <div>
      {err && <div className="login-err">{err}</div>}
      <div className="pair-flow" style={{ marginBottom: 16 }}>
        {pickSide('src', srcRemote, setSrcRemote, srcPath)}
        <div className="pair-mid" style={{ minWidth: 90 }}>
          <svg width="72" height="14" viewBox="0 0 104 14"><line x1="2" y1="7" x2="90" y2="7" stroke="#b9bedd" strokeWidth="2.5" strokeDasharray="1 7" strokeLinecap="round" /><path d="M90 1l10 6-10 6z" fill="#b9bedd" /></svg>
        </div>
        {pickSide('dst', dstRemote, setDstRemote, dstPath)}
      </div>

      {picking && (
        <div style={{ marginBottom: 16 }}>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>{picking === 'src' ? '源' : '目标'}网盘</label>
            <select className="select" value={picking === 'src' ? srcRemote : dstRemote}
              onChange={(e) => { if (picking === 'src') { setSrcRemote(e.target.value); setSrcPath(''); } else { setDstRemote(e.target.value); setDstPath(''); } }}>
              <option value="">请选择网盘…</option>
              {remotes.map((r) => <option key={r.name} value={r.name}>{r.name}（{r.type}）</option>)}
            </select>
          </div>
          <FolderPicker
            remote={picking === 'src' ? srcRemote : dstRemote}
            remoteType={(remotes.find((r) => r.name === (picking === 'src' ? srcRemote : dstRemote)) || {}).type}
            value={picking === 'src' ? srcPath : dstPath}
            onChange={(p) => { if (picking === 'src') setSrcPath(p); else setDstPath(p); }}
          />
          <div style={{ textAlign: 'right', marginTop: 10 }}>
            <button className="btn btn-primary btn-sm" onClick={() => setPicking('')}>就选这个文件夹</button>
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
      <div className="note-box" style={{ marginTop: 16 }}>
        同步方式为<strong>纯镜像</strong>：目标网盘会与源保持完全一致 —— 源里新增/修改的文件会同步过去，
        <strong>源里删除的文件，目标里也会被删除</strong>。比对使用校验和，改过的文件不会漏传。
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
        <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存任务'}</button>
      </div>
      <span style={{ display: 'none' }}>{srcR?.name}{dstR?.name}</span>
    </div>
  );
}

export default function Tasks({ toast }) {
  const [tasks, setTasks] = useState(null);
  const [remotes, setRemotes] = useState([]);
  const [editing, setEditing] = useState(undefined); // undefined=关, null=新建, obj=编辑
  const [runningId, setRunningId] = useState('');

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
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{t.name}</div>
              <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
                从 <b>{t.srcRemote}</b>{t.srcPath ? '/' + t.srcPath : ''} → 到 <b>{t.dstRemote}</b>{t.dstPath ? '/' + t.dstPath : ''}
              </div>
              <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>
                {scheduleText(t.schedule)}
                {t.enabled && t.nextRunAt && t.lastStatus !== 'running' && <> · 下次执行 {fmtTime(t.nextRunAt)}</>}
                {t.lastStatus === 'success' && <> · 上次成功 {fmtAgo(t.lastRunAt)}</>}
                {t.lastStatus === 'failed' && <> · <span style={{ color: 'var(--red-dark)' }}>上次失败 {fmtAgo(t.lastRunAt)}</span></>}
                {t.lastStatus === 'skipped' && <> · 上次已跳过（网盘暂停中）</>}
                {t.lastStatus === 'running' && <> · <span style={{ color: 'var(--indigo-600)' }}>正在执行…</span></>}
                {!t.lastStatus && <> · 尚未执行</>}
              </div>
            </div>
            {t.lastStatus === 'running'
              ? <span className="pill pill-run">备份中…</span>
              : t.enabled ? <span className="pill pill-ok">已启用</span> : <span className="pill pill-off">已停用</span>}
            <label className="switch" title={t.enabled ? '停用' : '启用'}>
              <input type="checkbox" checked={t.enabled} onChange={() => toggle(t)} />
              <span className="track" />
            </label>
            <button className="btn btn-primary btn-sm" disabled={runningId === t.id || t.lastStatus === 'running'} onClick={() => runNow(t)}>
              {t.lastStatus === 'running'
                ? <><span className="spin" style={{ width: 13, height: 13, borderWidth: 2 }} /> 执行中…</>
                : <><Icon name="play" size={13} /> 立即执行</>}
            </button>
            <button className="btn-link" onClick={() => setEditing(t)}>编辑</button>
            <button className="btn-link danger" onClick={() => remove(t)}>删除</button>
          </div>
        ))}
      </div>

      {editing !== undefined && (
        <Modal title={editing ? '编辑备份任务' : '新建备份任务'} sub="选好源和目标，再定个时间，剩下的交给它" wide onClose={() => setEditing(undefined)}>
          <TaskForm remotes={remotes} initial={editing} toast={toast}
            onDone={() => { setEditing(undefined); load(); }} />
        </Modal>
      )}
    </div>
  );
}
