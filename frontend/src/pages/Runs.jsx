import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { BigStatus, RunStatusWord, StageChain, Icon } from '../components.jsx';
import { fmtTimeSec, fmtDuration, fmtBytes } from '../util.js';

// #27：一次运行的变更明细（新增/更新/删除三类清单），默认折叠；老记录没有这个字段时不渲染。
function ChangesBlock({ changes, label }) {
  const [open, setOpen] = useState(false);
  if (!changes) return null;
  const groups = [
    ['added', '新增', 'var(--green-dark, #1d7a3a)'],
    ['updated', '更新', '#b97d1e'],
    ['deleted', '删除', 'var(--red-dark)']
  ];
  const cnt = (k) => changes.counts?.[k] ?? changes[k]?.length ?? 0;
  return (
    <div style={{ marginTop: 10 }}>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)} style={{ paddingLeft: 0 }}>
        {open ? '▾' : '▸'} {label ? `${label} · ` : ''}变更明细：新增 {cnt('added')} · 更新 {cnt('updated')} · 删除 {cnt('deleted')}
      </button>
      {open && (
        <div style={{ marginTop: 4 }}>
          {groups.map(([k, zh, color]) => (changes[k]?.length > 0 && (
            <div key={k} style={{ marginTop: 6 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color }}>{zh}（{changes[k].length}）</div>
              <div className="pv-list">
                {changes[k].map((f) => <div key={f} className="pv-item">{f}</div>)}
              </div>
            </div>
          )))}
          {changes.truncated && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>清单太长，每类只记录前 500 条；上方计数是全量。</div>}
        </div>
      )}
    </div>
  );
}

export function runSummary(run) {
  if (run.status === 'running') return '正在备份中…';
  if (run.status === 'skipped') return run.reasonZh || '已跳过';
  if (run.status === 'success') {
    const s = run.stats || {};
    if (s.transferred) return `传输了 ${s.transferred} 个文件（${fmtBytes(s.bytes || 0)}）`;
    return '没有文件变化，两边已经一致';
  }
  if (run.status === 'failed') {
    const s = run.stats || {};
    // #18：失败前已传出的部分如实写进一句话摘要，不再看上去像一个文件都没动
    if (s.transferred) return `已传 ${s.transferred} 个文件后失败：${run.reasonZh || '备份失败'}`;
  }
  return run.reasonZh || '备份失败';
}

// 紧凑行（#13）：默认只占两行——任务+状态+时间、一行简要摘要；
// 五阶段链、详细原因、日志、「标记已处理」全部收进「详情」展开区，点开才看
export function RunRow({ run, onHandled, showTask = true, highlighted = false }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function handle() {
    setBusy(true);
    try { await api.post(`/runs/${run.id}/handle`); onHandled?.(); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }
  const s = run.stats || {};
  return (
    <div className={`run-row${highlighted ? ' flash' : ''}`} id={`run-${run.id}`}>
      <BigStatus run={run} />
      <div className="rr-main">
        <div className="rr-title">
          {showTask && <span className="task-link">{run.taskName} · </span>}
          <RunStatusWord run={run} />
          {run.trigger === 'manual' && <span className="rr-manual">（手动执行）</span>}
          {run.trigger === 'schedule' && <span className="rr-manual">（定时执行）</span>}
          <span className="rr-time">{fmtTimeSec(run.startedAt)}</span>
        </div>
        <div className={`rr-sum${run.status === 'failed' && !run.handledAt ? ' bad' : ''}`} title={runSummary(run)}>{runSummary(run)}</div>
        {open && (
          <div className="rr-detail">
            <div className="rr-meta">
              开始 {fmtTimeSec(run.startedAt)}
              {run.finishedAt && <> · 用时 {fmtDuration(new Date(run.finishedAt) - new Date(run.startedAt))}</>}
              {s.checked != null && run.status === 'success' && <> · 比对 {s.checked} 个文件</>}
              {run.handledAt && <> · 已于 {fmtTimeSec(run.handledAt)} 标记为已处理</>}
            </div>
            <StageChain stages={run.stages} />
            {/* #27 变更明细：多组任务看各组自己的，单组任务看运行级聚合；老记录无字段自动跳过 */}
            {(run.pairs?.length > 1)
              ? run.pairs.map((p, i) => p.changes && <ChangesBlock key={i} changes={p.changes} label={`第 ${i + 1} 组`} />)
              : <ChangesBlock changes={run.changes} />}
            {run.status === 'failed' && run.reasonZh && (
              <div style={{ color: 'var(--red-dark)', fontSize: 13.5, marginTop: 6 }}>
                详细原因：{run.failedStageLabel ? `卡在「${run.failedStageLabel}」阶段——` : ''}{run.reasonZh}
              </div>
            )}
            {run.logExcerpt && <div className="log-box">{run.logExcerpt}</div>}
            {run.status === 'failed' && !run.handledAt && (
              <div style={{ marginTop: 10 }}>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={handle}>
                  <Icon name="check" size={14} /> 标记已处理
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="rr-actions">
        <button className="btn-link" onClick={() => setOpen(!open)}>{open ? '收起' : '详情'}</button>
      </div>
    </div>
  );
}

export default function RunsPage({ focusRunId = '' }) {
  const [runs, setRuns] = useState(null);
  const [filter, setFilter] = useState('all');
  async function load() {
    try { const d = await api.get('/runs?limit=100'); setRuns(d.runs); }
    catch (e) { setRuns([]); }
  }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!focusRunId || !runs) return;
    if (filter !== 'all') setFilter('all');
    const el = document.getElementById(`run-${focusRunId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusRunId, runs]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (runs || []).filter((r) =>
    filter === 'all' ? true : filter === 'failed' ? (r.status === 'failed' && !r.handledAt) : r.status === filter);
  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">运行记录</div>
          <div className="page-sub">每一次备份的过程与结果，失败能定位到具体阶段</div>
        </div>
        <div className="spacer" />
        <select className="select" style={{ width: 150 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">全部记录</option>
          <option value="success">只看成功</option>
          <option value="failed">只看未处理失败</option>
          <option value="skipped">只看已跳过</option>
          <option value="running">只看进行中</option>
        </select>
      </div>
      <div className="card">
        {runs === null && <div className="loading-page"><span className="spin" /> 加载中…</div>}
        {runs !== null && shown.length === 0 && (
          <div className="empty"><div className="e-ico"><Icon name="history" size={40} /></div>暂无符合条件的记录</div>
        )}
        {shown.map((r) => <RunRow key={r.id} run={r} onHandled={load} highlighted={r.id === focusRunId} />)}
      </div>
    </div>
  );
}
