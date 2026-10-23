import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { BrandBadge, Icon } from '../components.jsx';
import { typeLabel } from '../fieldhelp.js';
import { fmtAgo, fmtBytes, fmtTime, scheduleText } from '../util.js';

// #31：网盘详情页——基本信息 / 连接状态 / 容量 / 关系（同步给谁、被谁同步）/ 最近运行记录。
// 数据全部来自网关的只读聚合接口 GET /api/remotes/:name/detail；
// 「立即刷新」走 POST 同一接口（服务端当场实测一次连接 + 容量），不加任何轮询。

function statusWord(h, paused) {
  if (paused) return { word: '已暂停', cls: 'word-off' };
  if (!h || h.status === 'unknown' || !h.status) return { word: '未检测', cls: 'word-off' };
  if (h.status === 'down') return { word: '连接失效', cls: 'word-bad' };
  if (h.status === 'retrying') return { word: `连接异常（复测中 ${h.failCount || 1} 次）`, cls: 'word-warn' };
  if (h.status === 'ok') return { word: '连接正常', cls: 'word-ok' };
  return { word: h.status, cls: '' };
}

function modeWord(m) {
  if (m === 'copy') return '单向增加';
  if (m === 'bisync') return '双向同步';
  return '镜像同步';
}

function runWord(r) {
  if (r.status === 'success') return <span className="word-ok">备份成功</span>;
  if (r.status === 'running') return <span className="word-run">备份中…</span>;
  if (r.status === 'skipped') return <span className="word-off">已跳过</span>;
  return <span className="word-bad">备份失败</span>;
}

function RelList({ title, hint, items, arrow, nav }) {
  return (
    <div className="card detail-card">
      <div className="detail-card-title">{title}</div>
      {items.length === 0
        ? <div className="detail-empty">{hint}</div>
        : items.map((t) => (
          <button type="button" className="rel-row" key={t.id + t.otherRemote + t.otherPath} onClick={() => nav('tasks')}
            title="去备份任务页查看这个任务">
            <span className="rel-main">
              <span className="rel-task">{t.name}</span>
              <span className="rel-sub">
                {arrow}「{t.otherRemote}」{t.otherPath ? ` 的 ${t.otherPath}` : ' 根目录'}
                {' · '}{modeWord(t.mode)}{' · '}{scheduleText(t.schedule)}{t.enabled ? '' : ' · 已停用'}
              </span>
            </span>
            <span className="rel-last">
              {t.lastStatus
                ? <>{t.lastStatus === 'success' ? <span className="word-ok">上次成功</span>
                  : t.lastStatus === 'failed' ? <span className="word-bad">上次失败</span>
                  : t.lastStatus === 'running' ? <span className="word-run">运行中</span>
                  : <span className="word-off">上次已跳过</span>}
                  <span className="rel-time">{fmtAgo(t.lastRunAt)}</span></>
                : <span className="word-off">还没运行过</span>}
            </span>
          </button>
        ))}
    </div>
  );
}

export default function RemoteDetail({ name, nav, toast }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!name) return;
    try { setD(await api.get(`/remotes/${encodeURIComponent(name)}/detail`)); setErr(''); }
    catch (e) { setErr(e.message || '加载失败'); }
  }, [name]);
  useEffect(() => { setD(null); load(); }, [load]);

  async function refresh() {
    setRefreshing(true);
    try {
      setD(await api.post(`/remotes/${encodeURIComponent(name)}/detail`));
      toast(`「${name}」状态与容量已刷新`);
    } catch (e) { toast(e.message || '刷新失败', true); }
    finally { setRefreshing(false); }
  }

  if (!name) {
    return (
      <div className="card detail-card">
        <div className="detail-empty">还没有选中网盘。回「网盘管理」点任意一个网盘（或点左侧边栏里的网盘名）就能看它的详情。</div>
        <button className="btn btn-ghost" onClick={() => nav('remotes')}>去网盘管理</button>
      </div>
    );
  }
  if (err) return <div className="card detail-card"><div className="detail-empty">加载失败：{err}</div></div>;
  if (!d) return <div className="loading-page"><span className="spin" /> 加载中…</div>;

  const h = d.health || {};
  const sw = statusWord(h, d.paused);
  const about = h.about;
  return (
    <div className="detail-wrap">
      <div className="card detail-card">
        <div className="detail-head">
          <BrandBadge remote={d} size={52} />
          <div className="detail-head-main">
            <div className="detail-name">{d.name}
              {d.paused && <span className="pill pill-off" style={{ marginLeft: 8 }}>已暂停</span>}
              {d.needsCredentials && <span className="pill pill-fail" style={{ marginLeft: 8 }}>待补填凭证</span>}
            </div>
            <div className="detail-sub">{typeLabel(d.type) || d.type} 网盘{d.createdAt ? ` · 添加于 ${fmtTime(d.createdAt)}` : ''}</div>
          </div>
          <button className="btn btn-ghost" onClick={refresh} disabled={refreshing}>
            {refreshing ? <span className="spin" style={{ width: 13, height: 13 }} /> : <Icon name="refresh" size={14} />} 立即刷新
          </button>
        </div>

        <div className="detail-grid">
          <div className="detail-cell">
            <div className="detail-k">连接状态</div>
            <div className={`detail-v ${sw.cls}`}>{sw.word}</div>
            <div className="detail-note">
              {h.lastCheckAt ? `最近检查 ${fmtTime(h.lastCheckAt)}（${fmtAgo(h.lastCheckAt)}）` : '还没有检查过'}
              {h.lastOkAt && h.status !== 'ok' ? ` · 上次正常 ${fmtAgo(h.lastOkAt)}` : ''}
            </div>
            {h.cause && h.status !== 'ok' && <div className="detail-note word-bad">{h.cause}</div>}
            {h.remark && <div className="detail-note">{h.remark}</div>}
          </div>
          <div className="detail-cell">
            <div className="detail-k">容量</div>
            {about?.total
              ? <>
                  <div className="detail-v">已用 {fmtBytes(about.used ?? 0)} / 共 {fmtBytes(about.total)}</div>
                  <div className="cap-bar"><span style={{ width: `${Math.min(100, h.usedPercent ?? 0)}%` }} /></div>
                  <div className="detail-note">
                    {h.usedPercent != null ? `已用 ${h.usedPercent}%` : ''}
                    {about.free != null ? ` · 还剩 ${fmtBytes(about.free)}` : ''}
                  </div>
                </>
              : <>
                  <div className="detail-v">未知</div>
                  <div className="detail-note">这个网盘没有提供容量查询（不少网盘都不提供，属正常），点「立即刷新」可以再试一次。</div>
                </>}
          </div>
        </div>
      </div>

      <RelList title="同步给谁（这个网盘是备份来源）" hint="还没有任务拿这个网盘当备份来源。"
        items={d.tasksAsSrc} arrow="同步到 " nav={nav} />
      <RelList title="被谁同步（这个网盘是备份目标）" hint="还没有任务往这个网盘里备份。"
        items={d.tasksAsDst} arrow="来自 " nav={nav} />

      <div className="card detail-card">
        <div className="detail-card-title">最近运行记录（与这个网盘有关的任务）</div>
        {d.recentRuns.length === 0
          ? <div className="detail-empty">还没有运行记录。</div>
          : d.recentRuns.map((r) => (
            <div className="rel-row static" key={r.id}>
              <span className="rel-main">
                <span className="rel-task">{r.taskName}</span>
                <span className="rel-sub">{fmtTime(r.startedAt)}{r.stats?.files != null ? ` · 传输 ${r.stats.files} 个文件` : ''}{r.stats?.bytes != null ? ` · ${fmtBytes(r.stats.bytes)}` : ''}</span>
              </span>
              <span className="rel-last">{runWord(r)}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
