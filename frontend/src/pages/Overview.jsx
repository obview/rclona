import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { BrandBadge, Icon } from '../components.jsx';
import { RunRow } from './Runs.jsx';
import { fmtAgo, fmtBytes, fmtDuration, fmtHM, fmtTime, scheduleText } from '../util.js';

function driveHealthWord(r) {
  if (r.paused) return { dot: 'dot-paused', word: '已暂停', cls: 'word-off' };
  const h = r.health || {};
  if (h.status === 'down') return { dot: 'dot-bad', word: '连接失效', cls: 'word-bad' };
  if (h.status === 'retrying') return { dot: 'dot-warn', word: `连接异常（复测中 ${h.failCount || 1} 次）`, cls: 'word-warn' };
  if (h.status === 'ok') return { dot: 'dot-ok', word: '连接正常', cls: 'word-ok' };
  return { dot: 'dot-unknown', word: '尚未检查', cls: '' };
}

export default function Overview({ nav, gotoRun }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [handling, setHandling] = useState('');
  async function load() {
    try { setData(await api.get('/overview')); }
    catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);

  if (!data) return <div className="loading-page"><span className="spin" /> {err || '加载中…'}</div>;

  const { remotes, tasks, runs } = data;
  const stats = data.stats || { runs: 0, success: 0, failed: 0, bytes: 0, files: 0, lastRunFiles: null };
  const system = data.system || {};
  const unhandled = runs.filter((r) => r.status === 'failed' && !r.handledAt);
  const downRemotes = remotes.filter((r) => !r.paused && r.health?.status === 'down');
  const retryRemotes = remotes.filter((r) => !r.paused && r.health?.status === 'retrying');
  const pausedRemotes = remotes.filter((r) => r.paused);
  const abnormalRemotes = [...downRemotes, ...retryRemotes];
  const problemCount = unhandled.length + downRemotes.length;
  const lastFinished = runs.find((r) => r.status === 'success' || r.status === 'failed');
  const enabledTasks = tasks.filter((t) => t.enabled && t.nextRunAt);
  const nextTask = enabledTasks.length
    ? enabledTasks.reduce((a, b) => (new Date(a.nextRunAt) <= new Date(b.nextRunAt) ? a : b))
    : null;
  const lastCheckAt = remotes.reduce((acc, r) => {
    const t = r.health?.lastCheckAt;
    return t && (!acc || new Date(t) > new Date(acc)) ? t : acc;
  }, null);
  const uptimeMs = system.startedAt ? Date.now() - new Date(system.startedAt).getTime() : null;

  async function handleRun(run) {
    setHandling(run.id);
    try { await api.post(`/runs/${run.id}/handle`); load(); }
    catch (e) { alert(e.message); }
    setHandling('');
  }
  async function toggleTask(task) {
    await api.post(`/tasks/${task.id}/toggle`).catch(() => {});
    load();
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">概览</div>
          <div className="page-sub">监控仪表盘：有问题置顶显示，没问题就是一面信息墙</div>
        </div>
      </div>

      {/* ① 问题区：有未处理的问题才出现，置顶 */}
      {problemCount > 0 && (
        <div className="card problem-card">
          <div className="problem-head">
            <span className="a-icon"><Icon name="warn" size={19} /></span>
            <span>有 {problemCount} 项需要你处理</span>
          </div>
          {unhandled.map((r) => (
            <div className="problem-row" key={r.id}>
              <span className="p-dot fail" />
              <span className="p-text">「{r.taskName}」备份失败：{r.reasonZh || '未知原因'}</span>
              <span className="p-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => gotoRun(r.id)}>看详情</button>
                <button className="btn btn-primary btn-sm" disabled={handling === r.id} onClick={() => handleRun(r)}>标记已处理</button>
              </span>
            </div>
          ))}
          {downRemotes.map((r) => (
            <div className="problem-row" key={r.name}>
              <span className="p-dot fail" />
              <span className="p-text">网盘「{r.name}」连接失效{r.health?.cause ? `：${r.health.cause}` : ''}</span>
              <span className="p-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => nav('remotes')}>去处理</button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="dash-grid">
        {/* ② 状态总览 */}
        <div className="card card-pad dash-card">
          <div className="dash-card-head">
            <span className="card-title">状态总览</span>
            {problemCount > 0
              ? <span className="pill pill-fail">{problemCount} 项待处理</span>
              : <span className="pill pill-ok">✓ 一切正常</span>}
          </div>
          <div className="kv-list">
            <div className="kv-row">
              <span className="k">最近一次备份</span>
              <span className="v">
                {lastFinished
                  ? <>「{lastFinished.taskName}」{lastFinished.status === 'success'
                    ? <span className="word-ok">成功</span> : <span className="word-bad">失败</span>} · {fmtAgo(lastFinished.finishedAt || lastFinished.startedAt)}</>
                  : '还没有备份记录'}
              </span>
            </div>
            <div className="kv-row">
              <span className="k">下一次计划备份</span>
              <span className="v">{nextTask
                ? <>「{nextTask.name}」· {fmtTime(nextTask.nextRunAt)}</>
                : tasks.some((t) => t.enabled)
                  ? <span style={{ color: '#b97d1e' }}>近期无执行时间，请检查计划设置</span>
                  : '暂无已启用的任务'}</span>
            </div>
            <div className="kv-row">
              <span className="k">正在进行的任务</span>
              <span className="v">{tasks.filter((t) => t.lastStatus === 'running').length} 个</span>
            </div>
          </div>
        </div>

        {/* ③ 网盘状态：只列异常，全正常只给一句话 */}
        <div className="card card-pad dash-card">
          <div className="dash-card-head">
            <span className="card-title">网盘状态</span>
            <span style={{ display: 'flex', gap: 6 }}>
              {pausedRemotes.length > 0 && <span className="pill pill-off">{pausedRemotes.length} 个已暂停</span>}
              {abnormalRemotes.length > 0
                ? <span className="pill pill-fail">{abnormalRemotes.length} 个异常</span>
                : remotes.length > 0 && <span className="pill pill-ok">全部正常</span>}
            </span>
          </div>
          {remotes.length === 0 && (
            <div className="dash-empty">
              尚未添加网盘
              <button className="btn btn-primary btn-sm" onClick={() => nav('remotes')}>去添加网盘</button>
            </div>
          )}
          {remotes.length > 0 && abnormalRemotes.length === 0 && (
            <div className="all-ok-line">✓ 全部网盘连接正常{lastCheckAt ? ` · 上次检查 ${fmtHM(lastCheckAt)}` : ''}</div>
          )}
          {abnormalRemotes.map((r) => {
            const h = driveHealthWord(r);
            return (
              <React.Fragment key={r.name}>
                <div className="remote-line">
                  <span className={`status-dot ${h.dot}`} />
                  <BrandBadge remote={r} size={24} />
                  <span className="r-name">{r.name}</span>
                  <span className={`status-word ${h.cls}`}>{h.word}</span>
                  <span className="r-time">上次检查 {fmtAgo(r.health?.lastCheckAt)}</span>
                </div>
                {r.health?.cause && <div className="remote-cause">{r.health.cause}</div>}
              </React.Fragment>
            );
          })}
          {remotes.length > 0 && (
            <div className="dash-foot-note">每天凌晨自动检查全部网盘的连通性，异常会自动复测，并通过 Telegram 通知你</div>
          )}
        </div>

        {/* ④ 备份任务精简列表 */}
        <div className="card dash-card">
          <div className="dash-card-head pad">
            <span className="card-title">备份任务</span>
            <button className="btn-link" onClick={() => nav('tasks')}>管理全部 →</button>
          </div>
          {tasks.length === 0 && <div className="dash-empty">还没有备份任务，去「备份任务」页创建第一个</div>}
          {tasks.slice(0, 5).map((t) => (
            <div className="mini-task-row" key={t.id}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mt-name">{t.name}</div>
                <div className="mt-sub">
                  {scheduleText(t.schedule)}
                  {t.enabled && t.nextRunAt ? ` · 下次 ${fmtTime(t.nextRunAt)}` : ''}
                  {t.enabled && !t.nextRunAt && t.lastStatus !== 'running' ? ' · 近期无执行时间，请检查计划设置' : ''}
                  {t.lastStatus === 'running' ? ' · 正在执行…' : ''}
                </div>
              </div>
              {t.lastStatus === 'running'
                ? <span className="pill pill-run">备份中…</span>
                : t.lastStatus === 'failed'
                  ? <span className="pill pill-fail">上次失败</span>
                  : t.lastStatus === 'success'
                    ? <span className="pill pill-ok">正常</span>
                    : t.lastStatus === 'skipped'
                      ? <span className="pill pill-off">已跳过</span>
                      : <span className="pill pill-off">未执行</span>}
              <label className="switch" title={t.enabled ? '停用' : '启用'}>
                <input type="checkbox" checked={t.enabled} onChange={() => toggleTask(t)} />
                <span className="track" />
              </label>
            </div>
          ))}
        </div>

        {/* ⑥ 数据统计 */}
        <div className="card card-pad dash-card">
          <div className="dash-card-head"><span className="card-title">数据统计</span></div>
          <div className="stat-grid">
            <div className="stat-cell">
              <div className="stat-num">{stats.runs}</div>
              <div className="stat-label">累计备份次数</div>
            </div>
            <div className="stat-cell">
              <div className="stat-num">{fmtBytes(stats.bytes)}</div>
              <div className="stat-label">累计传输数据</div>
            </div>
            <div className="stat-cell">
              <div className="stat-num">{stats.files}</div>
              <div className="stat-label">累计传输文件</div>
            </div>
            <div className="stat-cell">
              <div className="stat-num">{stats.lastRunFiles == null ? '—' : stats.lastRunFiles}</div>
              <div className="stat-label">最近一次同步文件数</div>
            </div>
          </div>
        </div>

        {/* ⑤ 最近运行 */}
        <div className="card dash-card span2">
          <div className="dash-card-head pad">
            <span className="card-title">最近运行</span>
            <button className="btn-link" onClick={() => nav('runs')}>全部记录 →</button>
          </div>
          {runs.length === 0 && <div className="dash-empty">暂无备份记录</div>}
          {runs.slice(0, 5).map((r) => <RunRow key={r.id} run={r} onHandled={load} />)}
        </div>

        {/* ⑦ 系统信息 */}
        <div className="card card-pad dash-card span2">
          <div className="dash-card-head"><span className="card-title">系统信息</span></div>
          <div className="sys-grid">
            <div className="kv-row"><span className="k">rclone 版本</span><span className="v">{system.rcloneVersion ? `v${String(system.rcloneVersion).replace(/^v/, '')}` : '—'}</span></div>
            <div className="kv-row"><span className="k">服务已运行</span><span className="v">{uptimeMs != null ? fmtDuration(uptimeMs) : '—'}</span></div>
            <div className="kv-row"><span className="k">下次网盘自检</span><span className="v">{system.nextHealthCheckAt ? fmtTime(system.nextHealthCheckAt) : '—'}</span></div>
            <div className="kv-row"><span className="k">网盘 / 任务</span><span className="v">{remotes.length} 个网盘 · {tasks.length} 个任务</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
