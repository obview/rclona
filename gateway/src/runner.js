import { store, newId, pairsOf } from './store.js';
import { rc, fsSpec } from './rc.js';
import { stageReason, classifyError } from './classify.js';
import { notifyBackupFailure, notifyFirstScheduledSuccess } from './notifier.js';
import { pairFilterRules, escapeFilterLiteral } from './filters.js';
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
// skipTopDirs：源根目录下要整棵跳过的一级目录名集合（如备份 /host 时的虚拟目录），其余层级不跳
async function scanSource(fs, skipTopDirs = null) {
  const MAX = 5000;
  let files = 0, bytes = 0, truncated = false;
  const queue = [''];
  while (queue.length) {
    const dir = queue.shift();
    const { list } = await rc.list(fs, dir);
    for (const it of list || []) {
      if (files + queue.length > MAX * 2) { truncated = true; continue; }
      if (it.IsDir) {
        if (dir === '' && skipTopDirs && skipTopDirs.has(it.Name)) continue;
        queue.push(it.Path);
      }
      else { files++; bytes += it.Size || 0; }
    }
    if (files > MAX) { truncated = true; break; }
  }
  return { files, bytes, truncated };
}

// #14：备份源就是宿主机根目录挂载 /host 时，proc/sys/dev/run 是系统虚拟目录——
// 读了没用、内容时刻在变、还会让校验误报，同步/校验/扫描统一自动排除它们。
// 只认「本地目录网盘 + 源路径恰好是 /host」这一种情形；/host/etc 这类子目录本身不含虚拟目录，无需排除。
export const HOST_MOUNT = '/host';
export const HOST_VIRTUAL_DIRS = ['proc', 'sys', 'dev', 'run'];
export async function hostExcludesFor(srcRemote, srcPathRaw) {
  const srcPath = String(srcPathRaw || '').replace(/\/+$/, '');
  if (srcPath !== HOST_MOUNT) return null;
  let type = '';
  try { type = (await rc.getRemote(srcRemote))?.type || ''; } catch { /* 查不到类型就不排除 */ }
  if (type !== 'local') return null;
  return HOST_VIRTUAL_DIRS.map((d) => `${d}/**`);
}

// #18：经 WebDAV 工具（Flaredrive 等）写过的对象存储桶里常有「目录占位对象」——
// 一个 0 字节对象，其路径同时又是其它对象的目录前缀（如 appdata/legado 既是空文件、
// 又有 appdata/legado/… 的内容）。同步时目标端先建好同名目录、再放同名文件会被拒绝
// （Koofr 回 HTTP 400），整个任务被一颗空占位绊倒判失败；占位本身 0 字节、不含任何数据。
// 同步前用递归列表把它们识别出来逐个精确排除（只跳过不动源；非 0 字节或没有同名
// 目录内容的普通文件绝不排除——判定要求「存在另一条目以『该路径 + /』开头」）。
export async function findPlaceholderPaths(fs) {
  const { list } = await rc.listAll(fs);
  const entries = list || [];
  // 收集所有「是某个条目的上级目录」的路径（等价于：存在另一条目以「该路径 + /」开头）
  const ancestors = new Set();
  for (const it of entries) {
    const parts = String(it.Path || '').split('/');
    for (let i = 1; i < parts.length; i++) ancestors.add(parts.slice(0, i).join('/'));
  }
  const out = [];
  for (const it of entries) {
    if (!it.IsDir && (it.Size || 0) === 0 && it.Path && ancestors.has(it.Path)) out.push(it.Path);
  }
  return out;
}

// 一组映射的五阶段执行（#25）：逻辑与单组时代完全一致，只是失败不再直接终结整次运行，
// 而是把结果交回 runTask 聚合——一组失败，后面的组照常继续跑。
// stages/stats 是本组私有的记录格，onProgress 回调把聚合结果刷进运行记录（供界面实时看）。
async function runPair({ task, pair, log, stages, stats, onProgress }) {
  const srcFs = fsSpec(task.srcRemote, pair.src);
  const dstFs = fsSpec(task.dstRemote, pair.dst);
  const setStage = (i, status, durationMs) => {
    stages[i].status = status;
    if (durationMs != null) stages[i].durationMs = durationMs;
    onProgress();
  };
  const failAt = (stageIdx, errText) => {
    const { reasonZh } = stageReason(STAGES[stageIdx].label, errText);
    setStage(stageIdx, 'failed');
    return { ok: false, stageIdx, reasonZh, errText: String(errText) };
  };
  try {
    // #14：本组源是宿主机根目录（/host）时，自动排除系统虚拟目录（扫描/同步/校验全程一致）
    const hostPatterns = await hostExcludesFor(task.srcRemote, pair.src).catch(() => null);
    let autoFilterRules = (hostPatterns || []).map((p) => `- ${p}`);
    const skipTopDirs = hostPatterns ? new Set(HOST_VIRTUAL_DIRS) : null;
    if (hostPatterns) log(`源是服务器根目录（${HOST_MOUNT}），已自动排除系统虚拟目录：${HOST_VIRTUAL_DIRS.join('、')}`);

    // 阶段 1：连接源网盘
    let t0 = Date.now();
    setStage(0, 'running');
    try { await rc.list(srcFs, ''); }
    catch (e) { return failAt(0, e.message); }
    setStage(0, 'ok', Date.now() - t0);
    log('源网盘连接正常');

    // 阶段 2：扫描比对（递归列源目录，统计待比对文件）
    t0 = Date.now();
    setStage(1, 'running');
    let scan;
    try { scan = await scanSource(srcFs, skipTopDirs); }
    catch (e) { return failAt(1, `扫描源目录失败：${e.message}`); }
    setStage(1, 'ok', Date.now() - t0);
    stats.checked = scan.files;
    onProgress();
    log(`扫描完成：源共有 ${scan.files} 个文件（${(scan.bytes / 1048576).toFixed(2)} MB）${scan.truncated ? '（文件数过多，已抽样统计）' : ''}`);

    // 阶段 3：连接目标网盘 + 容量预检
    t0 = Date.now();
    setStage(2, 'running');
    try {
      await rc.list(dstFs, '');
    } catch (e) {
      if (classifyError(e.message).kind !== 'notfound') return failAt(2, e.message);
      // 目标目录还不存在：这不是故障——rclone sync 本来就会自动建目录，
      // 这里先替用户建好，让首次备份（目标从没建过）也能直接成功；建不出来才算失败
      try {
        await rc.mkdir(dstFs, '');
        log('目标目录不存在，已自动创建');
      } catch (mkErr) { return failAt(2, mkErr.message); }
    }
    try {
      const ab = await rc.about(dstFs);
      if (ab && typeof ab.free === 'number' && ab.free >= 0 && ab.free < scan.bytes) {
        return failAt(2, 'insufficient space: 目标可用空间小于源文件总大小');
      }
    } catch { /* about 不支持就跳过容量预检 */ }
    setStage(2, 'ok', Date.now() - t0);
    log('目标网盘连接正常');

    // #18：识别同名空占位并逐个精确排除；#26：再把本组用户筛选翻译成 FilterRule。
    // 合并顺序固定：系统自动排除（/host、空占位）在前，用户规则在后，任何用户规则
    // 都不能把系统已排除的内容又放回来；同一份合并规则传给 sync 与 check。
    try {
      const placeholders = await findPlaceholderPaths(srcFs);
      if (placeholders.length) {
        autoFilterRules.push(...placeholders.map((p) => `- /${escapeFilterLiteral(p)}`));
        log(`已自动跳过 ${placeholders.length} 个空占位对象（0 字节、与文件夹同名）：${placeholders.join('、')}`);
      }
    } catch (e) {
      log(`空占位对象检测未完成（${e.message}），按原样继续同步`);
    }
    const filterRules = [...autoFilterRules, ...pairFilterRules(pair.filters)];
    if (pair.filters?.length) log(`本组已启用 ${pair.filters.length} 条文件筛选规则`);

    // 阶段 4：真正传输（rc sync 异步任务，轮询状态）
    t0 = Date.now();
    setStage(3, 'running');
    let jobid;
    try { jobid = await rc.syncAsync(srcFs, dstFs, filterRules); }
    catch (e) { return failAt(3, e.message); }
    // 把这次同步的统计搬进本组统计：成功时是最终账，失败/超时时是「已传部分」的如实账（#18，不再记 0）
    const pullJobStats = async () => {
      try {
        const st = await rc.stats(`job/${jobid}`);
        stats.transferred = st.transfers ?? 0;
        stats.bytes = st.bytes ?? 0;
        stats.deletes = st.deletes ?? 0;
        if (typeof st.checks === 'number') stats.checked = Math.max(stats.checked || 0, st.checks);
        onProgress();
      } catch { /* 统计拿不到不影响结果 */ }
    };
    const deadline = Date.now() + cfg.runTimeoutMs;
    let job = null;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      try { job = await rc.jobStatus(jobid); } catch { continue; }
      if (job.finished) break;
      if (Date.now() > deadline) { await pullJobStats(); return failAt(3, '同步超时（超过设定时长仍未完成）'); }
    }
    if (!job.success) { await pullJobStats(); return failAt(3, job.error || '同步任务失败'); }
    await pullJobStats();
    setStage(3, 'ok', Date.now() - t0);
    log(`传输完成：同步了 ${stats.transferred ?? 0} 个文件`);

    // 阶段 5：校验（rclone check 复核两边一致性）
    t0 = Date.now();
    setStage(4, 'running');
    try {
      const chk = await rc.check(srcFs, dstFs, filterRules);
      const diffs = [...(chk.differ || []), ...(chk.missingOnSrc || []), ...(chk.missingOnDst || [])];
      const errs = chk.error || [];
      if (errs.length) return failAt(4, errs[0]);
      if (diffs.length) {
        return failAt(4, `校验发现 ${diffs.length} 处不一致：${diffs.slice(0, 10).join('、')}`);
      }
    } catch (e) {
      // check 本身调用失败（与“发现不一致”区分）：归类后报告
      const c = classifyError(e.message);
      if (c.kind === 'unknown') log(`校验调用异常（已忽略细节）：${e.message}`);
      else return failAt(4, e.message);
    }
    setStage(4, 'ok', Date.now() - t0);
    log('校验通过：两边文件一致');
    return { ok: true };
  } catch (e) {
    // 兜底：阶段外异常按当前运行中阶段归因
    const idx = stages.findIndex((s) => s.status === 'running');
    return failAt(idx >= 0 ? idx : 3, e.message);
  }
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
    pairs: [],
    logExcerpt: '',
    handledAt: null
  };
  store.addRun(run);
  const t = store.data.tasks.find((x) => x.id === task.id);
  if (t) { t.lastRunAt = run.startedAt; t.lastStatus = 'running'; store.save(); }

  const logLines = [];
  const log = (m) => { logLines.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`); };

  // #25：按映射列表逐组执行；运行记录的五阶段与统计是各组的聚合——
  // 某阶段只要有一组失败就记失败；统计把各组相加。一组失败不阻断后面的组。
  const pairs = pairsOf(task);
  const pairStageSets = pairs.map(() => STAGES.map((s) => ({ key: s.key, label: s.label, status: 'pending', durationMs: null })));
  const pairStats = pairs.map(() => ({}));
  const persistProgress = () => {
    run.stages = STAGES.map((s, i) => {
      const marks = pairStageSets.map((ps) => ps[i]);
      let status = 'ok';
      if (marks.some((m) => m.status === 'failed')) status = 'failed';
      else if (marks.some((m) => m.status === 'running')) status = 'running';
      else if (marks.every((m) => m.status === 'pending')) status = 'pending';
      const dur = marks.reduce((a, m) => a + (m.durationMs || 0), 0);
      return { key: s.key, label: s.label, status, durationMs: dur || null };
    });
    const agg = {};
    for (const ps of pairStats) {
      for (const k of ['transferred', 'bytes', 'deletes', 'checked']) {
        if (typeof ps[k] === 'number') agg[k] = (agg[k] || 0) + ps[k];
      }
    }
    run.stats = agg;
    store.updateRun(run.id, { stages: run.stages, stats: run.stats });
  };

  log(pairs.length > 1
    ? `开始备份：${task.srcRemote} → ${task.dstRemote}，共 ${pairs.length} 组文件夹（${trigger === 'schedule' ? '定时' : '手动'}触发）`
    : `开始备份：${fsSpec(task.srcRemote, pairs[0].src)} → ${fsSpec(task.dstRemote, pairs[0].dst)}（${trigger === 'schedule' ? '定时' : '手动'}触发）`);

  const pairResults = [];
  const failures = [];
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const srcFs = fsSpec(task.srcRemote, pair.src);
    const dstFs = fsSpec(task.dstRemote, pair.dst);
    if (pairs.length > 1) log(`—— 第 ${i + 1} 组：${srcFs} → ${dstFs} ——`);
    const r = await runPair({ task, pair, log, stages: pairStageSets[i], stats: pairStats[i], onProgress: persistProgress });
    pairResults.push({
      src: srcFs,
      dst: dstFs,
      status: r.ok ? 'success' : 'failed',
      failedStage: r.ok ? -1 : r.stageIdx,
      failedStageLabel: r.ok ? '' : STAGES[r.stageIdx].label,
      reasonZh: r.ok ? '' : r.reasonZh,
      stats: { ...pairStats[i] }
    });
    if (!r.ok) {
      failures.push({ idx: i, srcFs, dstFs, ...r });
      if (pairs.length > 1) log(`第 ${i + 1} 组失败：${r.reasonZh}`);
    }
    persistProgress();
  }
  run.pairs = pairResults;

  if (failures.length) {
    const f0 = failures[0];
    run.status = 'failed';
    run.failedStage = f0.stageIdx;
    run.failedStageLabel = STAGES[f0.stageIdx].label;
    if (pairs.length === 1) run.reasonZh = f0.reasonZh;
    else if (failures.length === 1) run.reasonZh = `第 ${f0.idx + 1} 组（${f0.srcFs} → ${f0.dstFs}）失败：${f0.reasonZh}`;
    else run.reasonZh = `共 ${failures.length} 组失败（共 ${pairs.length} 组）。第一处：第 ${f0.idx + 1} 组（${f0.srcFs} → ${f0.dstFs}）在「${STAGES[f0.stageIdx].label}」阶段失败：${f0.reasonZh}；其余失败组见日志`;
    run.finishedAt = new Date().toISOString();
    const detailLines = pairs.length === 1
      ? [`错误详情：${String(f0.errText).slice(0, 1500)}`]
      : failures.map((f) => `错误详情（第 ${f.idx + 1} 组）：${String(f.errText).slice(0, 800)}`);
    run.logExcerpt = [...logLines, ...detailLines].join('\n').slice(-6000);
    store.updateRun(run.id, run);
    const tt = store.data.tasks.find((x) => x.id === task.id);
    if (tt) { tt.lastStatus = 'failed'; store.save(); }
    running.delete(task.id);
    store.bumpStats(run);
    notifyBackupFailure(run).catch(() => {});
    console.log(`[runner] 任务「${task.name}」失败：${run.reasonZh}`);
    return run;
  }

  run.status = 'success';
  run.finishedAt = new Date().toISOString();
  run.logExcerpt = logLines.join('\n').slice(-6000);
  store.updateRun(run.id, run);
  const tt = store.data.tasks.find((x) => x.id === task.id);
  if (tt) { tt.lastStatus = 'success'; store.save(); }
  store.bumpStats(run);
  running.delete(task.id);
  console.log(`[runner] 任务「${task.name}」完成：传输 ${run.stats.transferred ?? 0} 个文件`);
  // #24：定时触发且成功、且这个任务从没报过喜 → 发一条「首次定时成功」并打持久标记，
  // 之后定时再成功不再发；手动成功永不发。先打标记再发送，避免异常重试导致重复报喜。
  if (trigger === 'schedule' && tt && !tt.firstSuccessNotified) {
    tt.firstSuccessNotified = true;
    store.save();
    notifyFirstScheduledSuccess(run, tt).catch(() => {});
  }
  return run;
}
