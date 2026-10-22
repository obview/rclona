import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { BrandBadge, Icon } from '../components.jsx';
import { RunRow } from './Runs.jsx';
import { fmtAgo, scheduleText } from '../util.js';

function healthOf(remote) {
  const h = remote.health || {};
  if (h.status === 'down') return { dot: 'dot-bad', word: '连接失效', cls: 'word-bad' };
  if (h.status === 'retrying') return { dot: 'dot-warn', word: `连接异常（复测中 ${h.failCount || 1} 次）`, cls: 'word-warn' };
  if (h.status === 'ok') return { dot: 'dot-ok', word: '连接正常', cls: 'word-ok' };
  return { dot: 'dot-unknown', word: '尚未检查', cls: '' };
}

export default function Overview({ nav }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  async function load() {
    try { setData(await api.get('/overview')); }
    catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);

  if (!data) return <div className="loading-page"><span className="spin" /> {err || '加载中…'}</div>;

  const { remotes, tasks, runs } = data;
  const task = tasks.find((t) => t.enabled) || tasks[0] || null;
  const srcR = task && remotes.find((r) => r.name === task.srcRemote);
  const dstR = task && remotes.find((r) => r.name === task.dstRemote);
  const lastRun = task ? runs.find((r) => r.taskId === task.id) : null;
  const unhandled = runs.filter((r) => r.status === 'failed' && !r.handledAt);
  const downRemotes = remotes.filter((r) => r.health?.status === 'down');
  const alertRun = unhandled[0];
  const alertCount = unhandled.length + downRemotes.length;

  async function handleAlertRun() {
    if (!alertRun) return;
    await api.post(`/runs/${alertRun.id}/handle`);
    load();
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">概览</div>
          <div className="page-sub">备份状态一眼看清：有没有失败、网盘连不连得上</div>
        </div>
      </div>

      {alertCount > 0 && (
        <div className="alert-card">
          <div className="a-icon"><Icon name="warn" size={20} /></div>
          <div>
            <div className="a-title">有 {alertCount} 项需要你处理</div>
            <div className="a-body">
              {alertRun && <>「{alertRun.taskName}」备份失败：{alertRun.reasonZh || '未知原因'}。</>}
              {downRemotes.length > 0 && <>网盘 {downRemotes.map((r) => `「${r.name}」`).join('、')} 连接失效。</>}
            </div>
          </div>
          <div className="a-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => nav('runs')}>看详情</button>
            {alertRun && <button className="btn btn-primary btn-sm" onClick={handleAlertRun}>标记已处理</button>}
          </div>
        </div>
      )}

      {/* 同步对卡（借鉴 MultCloud 同步页的视觉中心） */}
      <div className="card pair-card">
        {task ? (
          <>
            <div className="pair-flow">
              <div className="pair-side">
                <div className="p-badge" style={{ background: 'transparent' }}><BrandBadge remote={srcR || { name: task.srcRemote }} size={64} /></div>
                <div className="p-name">{task.srcRemote}</div>
                <div className="p-path">{task.srcPath ? (task.srcPath.startsWith('/') ? task.srcPath : '/' + task.srcPath) : '/（根目录）'}</div>
              </div>
              <div className="pair-mid">
                <div className="pair-arrow">
                  <svg width="104" height="14" viewBox="0 0 104 14"><line x1="2" y1="7" x2="90" y2="7" stroke="#b9bedd" strokeWidth="2.5" strokeDasharray="1 7" strokeLinecap="round" /><path d="M90 1l10 6-10 6z" fill="#b9bedd" /></svg>
                </div>
                <div className="p-status">
                  {!lastRun && <span className="pill pill-off">尚未执行</span>}
                  {lastRun?.status === 'running' && <span className="pill pill-run">备份中…</span>}
                  {lastRun?.status === 'success' && <span className="pill pill-ok">✓ 上次备份成功</span>}
                  {lastRun?.status === 'failed' && !lastRun.handledAt && <span className="pill pill-fail">✕ 上次备份失败</span>}
                  {lastRun?.status === 'failed' && lastRun.handledAt && <span className="pill pill-ok">✓ 失败已处理</span>}
                </div>
                <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{scheduleText(task.schedule)}{task.enabled ? '' : '（已停用）'}</div>
              </div>
              <div className="pair-side">
                <div className="p-badge" style={{ background: 'transparent' }}><BrandBadge remote={dstR || { name: task.dstRemote }} size={64} /></div>
                <div className="p-name">{task.dstRemote}</div>
                <div className="p-path">{task.dstPath ? (task.dstPath.startsWith('/') ? task.dstPath : '/' + task.dstPath) : '/（根目录）'}</div>
              </div>
            </div>
            <div style={{ textAlign: 'center', marginTop: 18 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => nav('tasks')}>管理备份任务（共 {tasks.length} 个）</button>
            </div>
          </>
        ) : (
          <div className="empty">
            <div className="e-ico"><Icon name="sync" size={42} /></div>
            还没有备份任务。先到「网盘管理」添加网盘，再回来创建第一个备份任务。
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => nav('remotes')}>去添加网盘</button>
            </div>
          </div>
        )}
      </div>

      {/* 网盘状态（紧凑一行式，学 RaiDrive 的克制） */}
      <div className="card card-pad section-gap">
        <div className="card-title">网盘状态</div>
        <div className="card-sub">每天凌晨 03:00 自动检查连通性，异常会复测并邮件通知你</div>
        <div style={{ marginTop: 8 }}>
          {remotes.length === 0 && <div style={{ color: 'var(--text-3)', padding: '10px 0' }}>尚未添加网盘</div>}
          {remotes.map((r) => {
            const h = healthOf(r);
            return (
              <React.Fragment key={r.name}>
                <div className="remote-line">
                  <span className={`status-dot ${h.dot}`} />
                  <BrandBadge remote={r} size={24} />
                  <span className="r-name">{r.name}</span>
                  <span className="r-type">{r.type}</span>
                  <span className={`status-word ${h.cls}`}>{h.word}</span>
                  <span className="r-time">上次检查 {fmtAgo(r.health?.lastCheckAt)}</span>
                </div>
                {(r.health?.status === 'down' || r.health?.status === 'retrying') && r.health?.cause && (
                  <div className="remote-cause">{r.health.cause}</div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* 最近备份记录 */}
      <div className="card section-gap">
        <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px 4px' }}>
          <div>
            <div className="card-title">最近备份记录</div>
            <div className="card-sub">点「详情」可看每一步的执行情况</div>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <button className="btn-link" onClick={() => nav('runs')}>全部记录 →</button>
          </div>
        </div>
        {runs.length === 0 && <div className="empty">暂无备份记录</div>}
        {runs.slice(0, 5).map((r) => <RunRow key={r.id} run={r} onHandled={load} />)}
      </div>
    </div>
  );
}
