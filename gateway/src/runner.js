import fs from 'node:fs';
import path from 'node:path';
import { store, newId, pairsOf } from './store.js';
import { rc, fsSpec } from './rc.js';
import { stageReason, classifyError } from './classify.js';
import { notifyBackupFailure, notifyFirstScheduledSuccess } from './notifier.js';
import { pairFilterRules, escapeFilterLiteral } from './filters.js';
import { taskOptionsOf, syncModeOf } from './taskopts.js';
import { ensureCryptRemote, dropCryptRemote } from './crypt.js';
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

// #27：旧版本保留的归档区目录名（位于每组目标文件夹内部，随该组一起被过滤排除在镜像之外）
export const ARCHIVE_DIR = '.rclona-archive';

// 面板时区下的日期串（YYYY-MM-DD），daysAgo=0 为今天
function dateStrInTz(daysAgo = 0) {
  return new Date(Date.now() - daysAgo * 86400000).toLocaleDateString('en-CA', { timeZone: cfg.tz });
}

// #30 双向同步（bisync）的状态管理：bisync 要靠「上次两边的清单」算增量，
// 清单（workdir）必须持久存放、按任务+组号隔离，放在数据目录下 bisync/<任务id>/<组号>/。
// 我们自己的一个小标记文件 rclona-state.json 记「这组是否已完成首次对齐（resync）」：
// 没对齐过 → 本次带 resync 跑（首次以源 path1 为准）；跑成功 → initialized=true。
// bisync 中途被打断导致其内部状态失效时，它下次会直接报错 aborted——我们据此把标记
// 清回未对齐并置 recovery=true，让再下一次执行自动重新对齐，且恢复对齐改用「较新者为准」
// （resyncMode=newer），避免拿源的旧文件覆盖目标的新文件（见 runPair 的 bisync 失败处理）。
export function bisyncWorkdir(taskId, pairIdx) {
  const safe = String(taskId).replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(cfg.dataDir, 'bisync', safe, String(pairIdx));
}
function readBisyncState(workdir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(workdir, 'rclona-state.json'), 'utf8'));
    return { initialized: !!s?.initialized, recovery: !!s?.recovery };
  } catch { return { initialized: false, recovery: false }; }
}
function writeBisyncState(workdir, state) {
  try {
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(workdir, 'rclona-state.json'), JSON.stringify(state));
  } catch { /* 标记写不下不阻断本次结果，下次大不了重新对齐 */ }
}

// 变更明细（#27）：operations/check 的三份名单就是「将新增/将更新/将删除」，
// 与真实运行、试运行预览共用同一来源，口径一致。每类封顶 cap 条，超出置 truncated。
export const CHANGES_CAP = 500;
export function changesFromCheck(chk, cap = CHANGES_CAP) {
  const one = (arr) => ({ list: (arr || []).slice(0, cap), total: (arr || []).length });
  const a = one(chk?.missingOnDst), u = one(chk?.differ), d = one(chk?.missingOnSrc);
  return {
    added: a.list, updated: u.list, deleted: d.list,
    counts: { added: a.total, updated: u.total, deleted: d.total },
    truncated: a.total > cap || u.total > cap || d.total > cap
  };
}

// 目标端现有文件数（删除安全阀的「比例」分母；归档区不算，它不在镜像删除范围内）
async function dstFileCount(dstFs) {
  const { list } = await rc.listAll(dstFs);
  return (list || []).filter((it) => !it.IsDir && !String(it.Path || '').startsWith(`${ARCHIVE_DIR}/`)).length;
}

// 计算一组映射的完整过滤规则：系统自动排除（/host 虚拟目录、#18 空占位、#27 归档区）
// 永远在前，用户规则（#26）在后——用户规则不能把系统排除的内容放回来。
// 真实同步、校验、同步前比对、试运行预览四处共用同一份，保证口径一致。
async function computePairFilters({ task, pair, srcFs, log }) {
  const opts = taskOptionsOf(task);
  const hostPatterns = await hostExcludesFor(task.srcRemote, pair.src).catch(() => null);
  const autoFilterRules = (hostPatterns || []).map((p) => `- ${p}`);
  const skipTopDirs = hostPatterns ? new Set(HOST_VIRTUAL_DIRS) : null;
  if (hostPatterns) log(`源是服务器根目录（${HOST_MOUNT}），已自动排除系统虚拟目录：${HOST_VIRTUAL_DIRS.join('、')}`);
  // #27：开了旧版本保留时，目标里的归档区必须对镜像隐身——否则下一轮同步会把归档当「多余文件」删掉
  if (opts.versioning.enabled) autoFilterRules.push(`- /${ARCHIVE_DIR}/**`);
  // #18：识别同名空占位并逐个精确排除
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
  return { filterRules, skipTopDirs };
}

// #27：清理某个归档区里超过保留天数的日期目录；归档区不存在/清理失败都不算错（返回已清个数）。
// 入参直接是归档区的 fs 规格：普通任务是目标网盘下的 .rclona-archive，
// 开了备份加密的任务要经 crypt 通道访问（归档在加密视图里，见 runTask 的清理循环）。
async function cleanupArchiveFs(archiveFs, keepDays) {
  let entries;
  try { entries = (await rc.list(archiveFs, '')).list || []; }
  catch { return 0; }
  const cutoff = dateStrInTz(keepDays); // 日期早于 cutoff 的归档已超保留期
  let n = 0;
  for (const it of entries) {
    if (!it.IsDir || !/^\d{4}-\d{2}-\d{2}$/.test(it.Name)) continue;
    if (it.Name < cutoff) { await rc.purge(archiveFs, it.Name); n++; }
  }
  return n;
}

// 一组映射的五阶段执行（#25）：逻辑与单组时代完全一致，只是失败不再直接终结整次运行，
// 而是把结果交回 runTask 聚合——一组失败，后面的组照常继续跑。
// stages/stats 是本组私有的记录格，onProgress 回调把聚合结果刷进运行记录（供界面实时看）。
async function runPair({ task, pair, pairIdx = 0, log, stages, stats, onProgress }) {
  const opts = taskOptionsOf(task);
  const mode = syncModeOf(task); // #30：mirror / copy / bisync，下面的阶段按模式分岔
  const srcFs = fsSpec(task.srcRemote, pair.src);
  const dstFs = fsSpec(task.dstRemote, pair.dst);
  // #27 B 段：开了备份加密时，阶段 3 起目标改走临时 crypt 通道（effDstFs），
  // 落盘的文件名/目录名/内容都是加密的；本组跑完在 finally 里拆掉通道。
  let cryptName = null;
  let effDstFs = dstFs;
  let pairChanges = null; // #27 变更明细（同步前比对得出），挂到本组结果上
  const setStage = (i, status, durationMs) => {
    stages[i].status = status;
    if (durationMs != null) stages[i].durationMs = durationMs;
    onProgress();
  };
  const failAt = (stageIdx, errText) => {
    const { reasonZh } = stageReason(STAGES[stageIdx].label, errText);
    setStage(stageIdx, 'failed');
    return { ok: false, stageIdx, reasonZh, errText: String(errText), changes: pairChanges };
  };
  try {
    // 过滤规则先算好（#14 /host 排除、#18 空占位、#26 用户筛选、#27 归档区隐身，合并口径见 computePairFilters）
    const { filterRules, skipTopDirs } = await computePairFilters({ task, pair, srcFs, log });

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

    // #27 B 段：备份加密——在连目标之前先架好 crypt 通道，之后所有对目标的操作都走它。
    // 架不起来（最常见：密码被清掉了）直接判阶段 3 失败，原因就是现成的人话，不再过分类器。
    if (opts.crypt.enabled) {
      try {
        cryptName = await ensureCryptRemote(task, pair, pairIdx);
        effDstFs = `${cryptName}:`;
        log('本组已启用备份加密：存到目标的文件名和内容都会加密');
      } catch (e) {
        setStage(2, 'failed');
        log(`备份加密准备失败：${e.message}`);
        return { ok: false, stageIdx: 2, reasonZh: e.message, errText: String(e.message), changes: pairChanges };
      }
    }

    // 阶段 3：连接目标网盘 + 容量预检
    t0 = Date.now();
    setStage(2, 'running');
    try {
      await rc.list(effDstFs, '');
    } catch (e) {
      if (classifyError(e.message).kind !== 'notfound') return failAt(2, e.message);
      // 目标目录还不存在：这不是故障——rclone sync 本来就会自动建目录，
      // 这里先替用户建好，让首次备份（目标从没建过）也能直接成功；建不出来才算失败
      try {
        await rc.mkdir(effDstFs, '');
        log('目标目录不存在，已自动创建');
      } catch (mkErr) { return failAt(2, mkErr.message); }
    }
    // 双向同步时文件是两边互通的，源总量不等于目标要接收的量，这个预检不适用，跳过
    if (mode !== 'bisync') {
      try {
        const ab = await rc.about(effDstFs);
        if (ab && typeof ab.free === 'number' && ab.free >= 0 && ab.free < scan.bytes) {
          return failAt(2, 'insufficient space: 目标可用空间小于源文件总大小');
        }
      } catch { /* about 不支持就跳过容量预检 */ }
    }
    setStage(2, 'ok', Date.now() - t0);
    log('目标网盘连接正常');

    // 同步前比对（#27）：与阶段 5 同一个 operations/check，先算清这次「将要」变更什么——
    // ① 得出变更明细记进运行记录；② 删除安全阀按将删数量把关，超限在真同步开始前就拦下，
    // 一个文件都不会删（不用 rclone 的 --max-delete：实测它是删到上限才报错的事后闸）。
    // 比对本身失败不阻断备份（记日志、明细留空、安全阀跳过把关）。
    // #30 按模式分岔：双向同步没有「单向将变更」的概念（两边互相合并），跳过比对与安全阀，
    // 明细留空；单向增加永不删除——比对里的「将删除」（目标比源多出的文件）对它不成立，
    // 明细里抹掉、安全阀也不适用（它拦的是镜像的删除传染）。
    if (mode === 'bisync') {
      log('同步方式为双向同步：变化会在两边互相合并，本次不生成单向变更明细、删除安全阀不适用');
    } else {
      try {
        const pre = await rc.check(srcFs, effDstFs, filterRules);
        pairChanges = changesFromCheck(pre);
        if (mode === 'copy' && pairChanges) {
          pairChanges = { ...pairChanges, deleted: [], counts: { ...pairChanges.counts, deleted: 0 } };
        }
      } catch (e) {
        log(`同步前比对未完成（${e.message}），直接同步；本次变更明细可能不完整`);
      }
    }
    if (mode === 'mirror' && pairChanges && (opts.maxDelete.count > 0 || opts.maxDelete.percent > 0)) {
      const limits = [];
      if (opts.maxDelete.count > 0) limits.push(opts.maxDelete.count);
      if (opts.maxDelete.percent > 0) {
        try {
          const total = await dstFileCount(effDstFs);
          if (total > 0) limits.push(Math.floor((total * opts.maxDelete.percent) / 100));
        } catch (e) { log(`安全阀的比例上限未生效（数不清目标现有文件数：${e.message}）`); }
      }
      if (limits.length) {
        const limit = Math.min(...limits);
        const wouldDelete = pairChanges.counts.deleted;
        if (wouldDelete > limit) {
          setStage(3, 'failed');
          const reasonZh = `本次要删除 ${wouldDelete} 个文件，超过删除安全阀上限 ${limit} 个，已中止以防误删（先点任务的「试运行」看清将删清单，确认无误后到任务设置里调高或关闭安全阀）`;
          log(`删除安全阀拦下本次同步：${reasonZh}`);
          return { ok: false, stageIdx: 3, guardTrip: { wouldDelete, limit }, reasonZh, errText: `安全阀拦截：${reasonZh}`, changes: pairChanges };
        }
      }
    }

    // 阶段 4：真正传输（rc 异步任务，轮询状态）——#30 按同步方式分发：
    // mirror → sync/sync（现状）；copy → sync/copy（只添/更新不删，归档口径与镜像相同、
    // 改名识别是 sync 专属，copy 不带）；bisync → sync/bisync（状态目录与首次对齐见上方助手）。
    t0 = Date.now();
    setStage(3, 'running');
    // #27 单次调用级配置：BackupDir（被覆盖/删除的文件先进归档区）、TrackRenames（改名不重传）
    const archiveDate = dateStrInTz(0);
    let bisyncCtx = null; // 双向同步时记 { wd, wasInitialized }，供成功/失败后维护对齐标记
    let jobid;
    try {
      if (mode === 'bisync') {
        const wd = bisyncWorkdir(task.id, pairIdx);
        fs.mkdirSync(wd, { recursive: true });
        const bst = readBisyncState(wd);
        bisyncCtx = { wd, wasInitialized: bst.initialized };
        jobid = await rc.bisyncAsync(srcFs, effDstFs, filterRules, {
          workdir: wd,
          resync: !bst.initialized,
          resyncMode: bst.recovery ? 'newer' : 'path1'
        });
        if (!bst.initialized) {
          log(bst.recovery
            ? '双向同步重新对齐：先以较新的文件为准把两边对齐一次，之后恢复双向互相同步'
            : '双向同步第一次执行：先以源网盘为准把两边对齐一次，之后才开始双向互相同步');
        }
      } else if (mode === 'copy') {
        const copyCfg = {};
        if (opts.versioning.enabled) copyCfg.BackupDir = `${effDstFs}/${ARCHIVE_DIR}/${archiveDate}`;
        jobid = await rc.copyAsync(srcFs, effDstFs, filterRules, copyCfg);
      } else {
        const syncCfg = {};
        if (opts.versioning.enabled) syncCfg.BackupDir = `${effDstFs}/${ARCHIVE_DIR}/${archiveDate}`;
        if (opts.trackRenames) syncCfg.TrackRenames = true;
        jobid = await rc.syncAsync(srcFs, effDstFs, filterRules, syncCfg);
      }
    }
    catch (e) { return failAt(3, e.message); }
    // #27 限速：_config 的 BwLimit 在 rcd 下实测不生效，只能拨全局开关——
    // 记住原值，同步一结束（成功/失败/超时都算）立刻恢复，避免影响别的任务与自检。
    let bwRestore = null;
    if (opts.bwlimit) {
      try {
        const cur = await rc.bwlimitGet();
        bwRestore = cur?.bytesPerSecond > 0 ? String(cur.bytesPerSecond) : 'off';
        await rc.bwlimitSet(opts.bwlimit);
        log(`已启用同步限速：${opts.bwlimit}（本任务同步期间有效）`);
      } catch (e) { log(`限速未生效（${e.message}），按不限速继续`); bwRestore = null; }
    }
    // 把这次同步的统计搬进本组统计：成功时是最终账，失败/超时时是「已传部分」的如实账（#18，不再记 0）
    const pullJobStats = async () => {
      try {
        const st = await rc.stats(`job/${jobid}`);
        stats.transferred = st.transfers ?? 0;
        stats.bytes = st.bytes ?? 0;
        stats.deletes = st.deletes ?? 0;
        if (typeof st.renames === 'number') stats.renames = st.renames;
        if (typeof st.checks === 'number') stats.checked = Math.max(stats.checked || 0, st.checks);
        onProgress();
      } catch { /* 统计拿不到不影响结果 */ }
    };
    const deadline = Date.now() + cfg.runTimeoutMs;
    let job = null;
    let timedOut = false;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      try { job = await rc.jobStatus(jobid); } catch { continue; }
      if (job.finished) break;
      if (Date.now() > deadline) { timedOut = true; break; }
    }
    if (bwRestore !== null) {
      try { await rc.bwlimitSet(bwRestore); } catch { /* 恢复失败不影响备份结果 */ }
      bwRestore = null;
    }
    if (timedOut) {
      // 双向同步被我们单方面判超时：bisync 内部状态可能已与清单脱节，标记为待恢复对齐
      if (bisyncCtx) writeBisyncState(bisyncCtx.wd, { initialized: false, recovery: true });
      await pullJobStats();
      return failAt(3, '同步超时（超过设定时长仍未完成）');
    }
    if (!job.success) {
      await pullJobStats();
      // 双向同步失败（安全中止/状态失效等）：清掉对齐标记，下次执行自动重新对齐
      // （恢复对齐以较新者为准）；失败原因由 classify 的 bisync 规则给人话。
      if (bisyncCtx) writeBisyncState(bisyncCtx.wd, { initialized: false, recovery: true });
      return failAt(3, job.error || '同步任务失败');
    }
    if (bisyncCtx) writeBisyncState(bisyncCtx.wd, { initialized: true, recovery: false });
    await pullJobStats();
    setStage(3, 'ok', Date.now() - t0);
    log(`传输完成：同步了 ${stats.transferred ?? 0} 个文件`);
    if (mode === 'copy') log('同步方式为单向增加：源里删除的文件不会从目标删掉，目标里多出的文件也会保留');
    if (stats.renames) log(`其中 ${stats.renames} 个文件只是改了名字（已在目标直接改名，没有重传）`);
    if (mode !== 'bisync' && opts.versioning.enabled && pairChanges) {
      const archived = pairChanges.counts.updated + pairChanges.counts.deleted;
      if (archived > 0) log(`被覆盖/删除的 ${archived} 个文件已先移入归档区（${pair.dst ? `${pair.dst}/` : ''}${ARCHIVE_DIR}/${archiveDate}），保留 ${opts.versioning.keepDays} 天后自动清理`);
    }

    // 阶段 5：校验（rclone check 复核两边一致性）
    // #30：双向同步由 bisync 在收尾时自行核对两边最终清单（checkSync 默认开），
    // 单向 check 的口径（谁多谁少）对双向不成立，这里直接采信其结果；
    // 单向增加则只核对「源的文件是否都到了、内容对不对」——目标多出的文件是预期保留，不算不一致。
    t0 = Date.now();
    setStage(4, 'running');
    if (mode === 'bisync') {
      setStage(4, 'ok', Date.now() - t0);
      log('校验通过：双向同步已由 rclone 自行核对，两边清单一致');
      return { ok: true, changes: pairChanges };
    }
    try {
      const chk = await rc.check(srcFs, effDstFs, filterRules);
      const diffs = mode === 'copy'
        ? [...(chk.differ || []), ...(chk.missingOnDst || [])]
        : [...(chk.differ || []), ...(chk.missingOnSrc || []), ...(chk.missingOnDst || [])];
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
    return { ok: true, changes: pairChanges };
  } catch (e) {
    // 兜底：阶段外异常按当前运行中阶段归因
    const idx = stages.findIndex((s) => s.status === 'running');
    return failAt(idx >= 0 ? idx : 3, e.message);
  } finally {
    // #27 B 段：本组跑完（成败都算）拆掉临时 crypt 通道，不在 rclone 配置里留加密定义
    if (cryptName) await dropCryptRemote(cryptName);
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
      for (const k of ['transferred', 'bytes', 'deletes', 'checked', 'renames']) {
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
    const r = await runPair({ task, pair, pairIdx: i, log, stages: pairStageSets[i], stats: pairStats[i], onProgress: persistProgress });
    pairResults.push({
      src: srcFs,
      dst: dstFs,
      status: r.ok ? 'success' : 'failed',
      failedStage: r.ok ? -1 : r.stageIdx,
      failedStageLabel: r.ok ? '' : STAGES[r.stageIdx].label,
      reasonZh: r.ok ? '' : r.reasonZh,
      stats: { ...pairStats[i] },
      changes: r.changes || null
    });
    if (!r.ok) {
      failures.push({ idx: i, srcFs, dstFs, ...r });
      if (pairs.length > 1) log(`第 ${i + 1} 组失败：${r.reasonZh}`);
    }
    persistProgress();
  }
  run.pairs = pairResults;

  // #27：运行级变更明细 = 各组明细的聚合（每类仍封顶 500 条，计数是全量）
  const withChanges = pairResults.filter((p) => p.changes);
  if (withChanges.length) {
    const agg = { added: [], updated: [], deleted: [], counts: { added: 0, updated: 0, deleted: 0 }, truncated: false };
    for (const p of withChanges) {
      for (const k of ['added', 'updated', 'deleted']) {
        agg.counts[k] += p.changes.counts[k];
        for (const f of p.changes[k]) if (agg[k].length < CHANGES_CAP) agg[k].push(f);
      }
      if (p.changes.truncated) agg.truncated = true;
    }
    for (const k of ['added', 'updated', 'deleted']) if (agg[k].length < agg.counts[k]) agg.truncated = true;
    run.changes = agg;
  }

  // #27：开了旧版本保留的任务，每次运行后顺带清理过期归档（失败只记日志，不影响备份结果）。
  // 开了备份加密的任务，归档区在加密视图里，清理时要临时再架一次 crypt 通道去访问。
  const taskOpts = taskOptionsOf(task);
  // #30：双向同步不用归档区（它的备份目录语义与单向不同），开了旧版本保留也不处理
  if (taskOpts.versioning.enabled && syncModeOf(task) !== 'bisync') {
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      let tmpCrypt = null;
      try {
        let archiveFs;
        if (taskOpts.crypt.enabled) {
          tmpCrypt = await ensureCryptRemote(task, pair, i);
          archiveFs = `${tmpCrypt}:${ARCHIVE_DIR}`;
        } else {
          archiveFs = fsSpec(task.dstRemote, pair.dst ? `${pair.dst}/${ARCHIVE_DIR}` : ARCHIVE_DIR);
        }
        const n = await cleanupArchiveFs(archiveFs, taskOpts.versioning.keepDays);
        if (n > 0) log(`已清理 ${n} 个过期归档（超过 ${taskOpts.versioning.keepDays} 天）`);
      } catch (e) { log(`归档清理未完成（${e.message}），下次运行时再试`); }
      finally { if (tmpCrypt) await dropCryptRemote(tmpCrypt); }
    }
  }

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

// #27 试运行预览：只比对、绝不动目标——不建目录、不落运行记录、不发通知。
// 每组先算与真实运行完全相同的过滤规则，再跑 operations/check 得将变更清单
// （新增=目标缺失、更新=内容不同、删除=源里没有；与真实运行的变更明细同源同口径），
// 另跑一次 DryRun 的 sync 拿计数交叉核对（清单以 check 为准，计数对不上时以清单为准展示）。
const PREVIEW_CAP = 200;
export async function previewTask(task) {
  const pairs = pairsOf(task);
  const out = [];
  const taskOpts = taskOptionsOf(task);
  const mode = syncModeOf(task); // #30：预览也按同步方式分口径
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const srcFs = fsSpec(task.srcRemote, pair.src);
    const dstFs = fsSpec(task.dstRemote, pair.dst);
    const item = {
      src: srcFs, dst: dstFs,
      added: [], updated: [], deleted: [],
      counts: { added: 0, updated: 0, deleted: 0 },
      truncated: false, dryRun: null, error: ''
    };
    let tmpCrypt = null;
    try {
      // 开了备份加密的任务，预览也要对着加密视图比对（口径与真跑一致）
      let effDstFs = dstFs;
      if (taskOpts.crypt.enabled) {
        tmpCrypt = await ensureCryptRemote(task, pair, i);
        effDstFs = `${tmpCrypt}:`;
      }
      const sink = [];
      const { filterRules } = await computePairFilters({ task, pair, srcFs, log: (m) => sink.push(m) });
      if (mode === 'bisync') {
        // #30 双向同步的试运行：没有单向清单可列（变化是两边合并的），改跑一次 bisync 的
        // dry-run 拿「大约要互传多少个文件」的总数，以说明文字呈现（item.note）。
        // 还没完成首次对齐的组没法 dry-run（bisync 会直接拒绝），如实告知先真跑一次。
        const wd = bisyncWorkdir(task.id, i);
        if (!readBisyncState(wd).initialized) {
          item.error = '这个任务还没跑过第一次双向同步：请先点「立即执行」完成首次对齐，之后才能试运行';
        } else {
          const jobid = await rc.bisyncAsync(srcFs, effDstFs, filterRules, { workdir: wd, dryRun: true });
          const deadline = Date.now() + 10 * 60 * 1000;
          let job = null;
          for (;;) {
            await new Promise((r) => setTimeout(r, 1000));
            job = await rc.jobStatus(jobid).catch(() => null);
            if (job?.finished) break;
            if (Date.now() > deadline) break;
          }
          if (job?.finished && job.success) {
            const st = await rc.stats(`job/${jobid}`);
            const n = st.transfers ?? 0;
            item.note = n > 0
              ? `双向同步试运行：两边大约有 ${n} 个文件需要互相传递（新增、更新、删除合并计算，以实际执行为准）。双向同步没有单向的清单——谁更新就同步给谁。`
              : '双向同步试运行：两边已经一致，真跑也不会动任何文件。';
            item.dryRun = { transfers: n, deletes: st.deletes ?? 0 };
          } else {
            item.error = `双向同步试运行没跑成：${job?.error || '未知原因'}（正式执行时会给出更具体的原因）`;
          }
        }
        out.push(item);
        continue;
      }
      const chk = await rc.check(srcFs, effDstFs, filterRules);
      const ch = changesFromCheck(chk, PREVIEW_CAP);
      item.added = ch.added; item.updated = ch.updated; item.deleted = ch.deleted;
      item.counts = ch.counts; item.truncated = ch.truncated;
      // #30 单向增加：没有「将删除」——目标多出的文件会被保留，清单里不列、计数归零
      if (mode === 'copy') { item.deleted = []; item.counts = { ...item.counts, deleted: 0 }; }
      try {
        const jobid = mode === 'copy'
          ? await rc.copyAsync(srcFs, effDstFs, filterRules, { DryRun: true })
          : await rc.syncAsync(srcFs, effDstFs, filterRules, { DryRun: true });
        const deadline = Date.now() + 10 * 60 * 1000;
        let job = null;
        for (;;) {
          await new Promise((r) => setTimeout(r, 1000));
          job = await rc.jobStatus(jobid).catch(() => null);
          if (job?.finished) break;
          if (Date.now() > deadline) break;
        }
        if (job?.finished && job.success) {
          const st = await rc.stats(`job/${jobid}`);
          item.dryRun = { transfers: st.totalTransfers ?? st.transfers ?? 0, deletes: st.deletes ?? 0 };
        }
      } catch { /* 交叉核对拿不到不影响清单本身 */ }
    } catch (e) {
      // 加密准备失败的原因本身就是完整人话（如密码未设置），直接展示，不走分类器
      item.error = /备份加密/.test(e.message) ? e.message : classifyError(e.message).reasonZh;
    } finally {
      if (tmpCrypt) await dropCryptRemote(tmpCrypt);
    }
    out.push(item);
  }
  return { pairs: out };
}
