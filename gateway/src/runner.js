import { store, newId } from './store.js';
import { rc, fsSpec } from './rc.js';
import { stageReason, classifyError } from './classify.js';
import { notifyBackupFailure } from './notifier.js';
import { cfg } from './config.js';

// 备份执行：固定五阶段。先做飞行前检查（把失败定位到阶段），再跑真正的 sync，最后校验
export const STAGES = [
  { key: 'connectSrc', label: '连接源网盘' },
  { key: 'scan', label: '扫描比对' },
  { key: 'connectDst', label: '连接目标网盘' },
  { key: 'transfer', label: '传输文件' },
  { key: 'verify', label: '校验' }
];

const running = new Set();
export const isRunning = (taskId) => running.has(taskId);

// 递归扫描源目录（BFS 分层 list），供「扫描比对」阶段与容量预检使用；条目数封顶防止超大盘拖垮
async function scanSource(fs) {
  const MAX = 5000;
  let files = 0, bytes = 0, truncated = false;
  const queue = [''];
  while (queue.length) {
    const dir = queue.shift();
    const { list } = await rc.list(fs, dir);
    for (const it of list || []) {
      if (files + queue.length > MAX * 2) { truncated = true; continue; }
      if (it.IsDir) queue.push(it.Path);
      else { files++; bytes += it.Size || 0; }
    }
    if (files > MAX) { truncated = true; break; }
  }
  return { files, bytes, truncated };
}

export async function runTask(task, trigger = 'manual') {
  if (running.has(task.id)) return { skipped: true, reason: '该任务正在执行中' };

  // 网盘已暂停：本次跳过，留一条「已跳过」记录（不算失败、不发通知、不计入累计备份次数）
  const pausedRemote = [task.srcRemote, task.dstRemote].find((n) => store.isPaused(n));
  if (pausedRemote) {
    const nowIso = new Date().toISOString();
    const run = {
      id: newId(),
      taskId: task.id,
      taskName: task.name,
      trigger,
      startedAt: nowIso,
      finishedAt: nowIso,
      status: 'skipped',
      failedStage: -1,
      failedStageLabel: '',
      reasonZh: `网盘「${pausedRemote}」已暂停，本次备份跳过`,
      stages: STAGES.map((s) => ({ key: s.key, label: s.label, status: 'skipped', durationMs: null })),
      stats: {},
      logExcerpt: '源或目标网盘处于暂停状态，本次执行跳过。恢复网盘后，下一个计划时刻会照常备份。',
      handledAt: null
    };
    store.addRun(run);
    const t = store.data.tasks.find((x) => x.id === task.id);
    if (t) { t.lastRunAt = nowIso; t.lastStatus = 'skipped'; store.save(); }
    console.log(`[runner] 任务「${task.name}」跳过：网盘「${pausedRemote}」已暂停`);
    return run;
  }

  running.add(task.id);

  const run = {
    id: newId(),
    taskId: task.id,
    taskName: task.name,
    trigger,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    failedStage: -1,
    failedStageLabel: '',
    reasonZh: '',
    stages: STAGES.map((s) => ({ key: s.key, label: s.label, status: 'pending', durationMs: null })),
    stats: {},
    logExcerpt: '',
    handledAt: null
  };
  store.addRun(run);
  const t = store.data.tasks.find((x) => x.id === task.id);
  if (t) { t.lastRunAt = run.startedAt; t.lastStatus = 'running'; store.save(); }

  const logLines = [];
  const log = (m) => { logLines.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`); };
  const srcFs = fsSpec(task.srcRemote, task.srcPath);
  const dstFs = fsSpec(task.dstRemote, task.dstPath);
  log(`开始备份：${srcFs} → ${dstFs}（${trigger === 'schedule' ? '定时' : '手动'}触发）`);

  const setStage = (i, status, durationMs) => {
    run.stages[i].status = status;
    if (durationMs != null) run.stages[i].durationMs = durationMs;
    store.updateRun(run.id, { stages: run.stages });
  };
  const fail = async (stageIdx, errText) => {
    const { reasonZh } = stageReason(STAGES[stageIdx].label, errText);
    setStage(stageIdx, 'failed');
    run.status = 'failed';
    run.failedStage = stageIdx;
    run.failedStageLabel = STAGES[stageIdx].label;
    run.reasonZh = reasonZh;
    run.finishedAt = new Date().toISOString();
    run.logExcerpt = [...logLines, `错误详情：${String(errText).slice(0, 1500)}`].join('\n').slice(-6000);
    store.updateRun(run.id, run);
    const tt = store.data.tasks.find((x) => x.id === task.id);
    if (tt) { tt.lastStatus = 'failed'; store.save(); }
    running.delete(task.id);
    store.bumpStats(run);
    log(`失败：${reasonZh}`);
    notifyBackupFailure(run).catch(() => {});
    console.log(`[runner] 任务「${task.name}」失败：${reasonZh}`);
    return run;
  };

  try {
    // 阶段 1：连接源网盘
    let t0 = Date.now();
    setStage(0, 'running');
    try { await rc.list(srcFs, ''); }
    catch (e) { return fail(0, e.message); }
    setStage(0, 'ok', Date.now() - t0);
    log('源网盘连接正常');

    // 阶段 2：扫描比对（递归列源目录，统计待比对文件）
    t0 = Date.now();
    setStage(1, 'running');
    let scan;
    try { scan = await scanSource(srcFs); }
    catch (e) { return fail(1, `扫描源目录失败：${e.message}`); }
    setStage(1, 'ok', Date.now() - t0);
    run.stats.checked = scan.files;
    log(`扫描完成：源共有 ${scan.files} 个文件（${(scan.bytes / 1048576).toFixed(2)} MB）${scan.truncated ? '（文件数过多，已抽样统计）' : ''}`);

    // 阶段 3：连接目标网盘 + 容量预检
    t0 = Date.now();
    setStage(2, 'running');
    try {
      await rc.list(dstFs, '');
    } catch (e) {
      if (classifyError(e.message).kind !== 'notfound') return fail(2, e.message);
      // 目标目录还不存在：这不是故障——rclone sync 本来就会自动建目录，
      // 这里先替用户建好，让首次备份（目标从没建过）也能直接成功；建不出来才算失败
      try {
        await rc.mkdir(dstFs, '');
        log('目标目录不存在，已自动创建');
      } catch (mkErr) { return fail(2, mkErr.message); }
    }
    try {
      const ab = await rc.about(dstFs);
      if (ab && typeof ab.free === 'number' && ab.free >= 0 && ab.free < scan.bytes) {
        return fail(2, 'insufficient space: 目标可用空间小于源文件总大小');
      }
    } catch { /* about 不支持就跳过容量预检 */ }
    setStage(2, 'ok', Date.now() - t0);
    log('目标网盘连接正常');

    // 阶段 4：真正传输（rc sync 异步任务，轮询状态）
    t0 = Date.now();
    setStage(3, 'running');
    let jobid;
    try { jobid = await rc.syncAsync(srcFs, dstFs); }
    catch (e) { return fail(3, e.message); }
    const deadline = Date.now() + cfg.runTimeoutMs;
    let job = null;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      try { job = await rc.jobStatus(jobid); } catch { continue; }
      if (job.finished) break;
      if (Date.now() > deadline) return fail(3, '同步超时（超过设定时长仍未完成）');
    }
    if (!job.success) return fail(3, job.error || '同步任务失败');
    try {
      const st = await rc.stats(`job/${jobid}`);
      run.stats.transferred = st.transfers ?? 0;
      run.stats.bytes = st.bytes ?? 0;
      run.stats.deletes = st.deletes ?? 0;
      if (typeof st.checks === 'number') run.stats.checked = Math.max(run.stats.checked || 0, st.checks);
    } catch { /* 统计拿不到不影响结果 */ }
    setStage(3, 'ok', Date.now() - t0);
    log(`传输完成：同步了 ${run.stats.transferred ?? 0} 个文件`);

    // 阶段 5：校验（rclone check 复核两边一致性）
    t0 = Date.now();
    setStage(4, 'running');
    try {
      const chk = await rc.check(srcFs, dstFs);
      const diffs = [...(chk.differ || []), ...(chk.missingOnSrc || []), ...(chk.missingOnDst || [])];
      const errs = chk.error || [];
      if (errs.length) return fail(4, errs[0]);
      if (diffs.length) {
        return fail(4, `校验发现 ${diffs.length} 处不一致：${diffs.slice(0, 10).join('、')}`);
      }
    } catch (e) {
      // check 本身调用失败（与“发现不一致”区分）：归类后报告
      const c = classifyError(e.message);
      if (c.kind === 'unknown') log(`校验调用异常（已忽略细节）：${e.message}`);
      else return fail(4, e.message);
    }
    setStage(4, 'ok', Date.now() - t0);
    log('校验通过：两边文件一致');

    run.status = 'success';
    run.finishedAt = new Date().toISOString();
    run.logExcerpt = logLines.join('\n').slice(-6000);
    store.updateRun(run.id, run);
    const tt = store.data.tasks.find((x) => x.id === task.id);
    if (tt) { tt.lastStatus = 'success'; store.save(); }
    store.bumpStats(run);
    running.delete(task.id);
    console.log(`[runner] 任务「${task.name}」完成：传输 ${run.stats.transferred ?? 0} 个文件`);
    return run;
  } catch (e) {
    // 兜底：阶段外异常按当前运行中阶段归因
    const idx = run.stages.findIndex((s) => s.status === 'running');
    return fail(idx >= 0 ? idx : 3, e.message);
  }
}
