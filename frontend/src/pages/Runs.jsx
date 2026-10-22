import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { BigStatus, RunStatusWord, StageChain, Icon } from '../components.jsx';
import { fmtTimeSec, fmtDuration, fmtBytes } from '../util.js';

export function runSummary(run) {
  if (run.status === 'running') return '正在备份中…';
  if (run.status === 'skipped') return run.reasonZh || '已跳过';
  if (run.status === 'success') {
    const s = run.stats || {};
    if (s.transferred) return `传输了 ${s.transferred} 个文件（${fmtBytes(s.bytes || 0)}）`;
    return '没有文件变化，两边已经一致';
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
