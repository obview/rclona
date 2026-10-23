// rclona 网关端到端自测（无需真实网盘：本地目录 remote + 假 WebDAV 服务）
// 运行：npm run test:e2e（需要 RCLONE_BIN 指向 rclone 二进制，默认用仓库 .tools/rclone）
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { classifyError } from '../src/classify.js';
import { pairFilterRules } from '../src/filters.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T = '/tmp/rclona-e2e';
const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;
const RCLONE_BIN = process.env.RCLONE_BIN || path.join(ROOT, '.tools', 'rclone');

let failures = 0;
function ok(cond, label, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 30000, step = 400) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor 超时');
    await sleep(step);
  }
}

let cookie = '';
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

// 假 WebDAV：只实现 PROPFIND 的集合响应，够 rclone 列表成功
function startFakeDav(port) {
  const srv = http.createServer((req, res) => {
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/</d:href>
    <d:propstat><d:prop><d:displayname>dav</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`);
    } else { res.writeHead(200); res.end('ok'); }
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

// 假 Telegram Bot API：记录所有 sendMessage 请求，永远回 ok
const TG_PORT = 18790;
const tgMessages = [];
function startFakeTelegram(port) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body); } catch { /* ignore */ }
      tgMessages.push({ url: req.url, chat_id: data.chat_id, text: data.text || '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}
const tgHas = (a, b = '') => tgMessages.some((m) => m.text.includes(a) && m.text.includes(b));

// 假 S3：mode=denied 时 ListBuckets 回 403 AccessDenied（单桶令牌的真实行为），
// 但指定桶名的 ListObjects 正常；mode=badkey 时一律回 403 InvalidAccessKeyId（真凭证错误）
function startFakeS3(port, mode) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const errXml = (code, msg) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${msg}</Message><RequestId>fake</RequestId></Error>`;
    if (mode === 'badkey') {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      return res.end(errXml('InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.'));
    }
    if (u.pathname === '/' && req.method === 'GET' && !u.searchParams.has('list-type')) {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      return res.end(errXml('AccessDenied', 'Access Denied'));
    }
    // 列具体桶：返回空列表（桶里没文件，但桶本身可达）
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>webdav</Name><Prefix></Prefix><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

async function main() {
  fs.rmSync(T, { recursive: true, force: true });
  const srcDir = path.join(T, 'srcbase', 'data1');
  const dstDir = path.join(T, 'dstbase', 'bak');
  fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true });
  fs.mkdirSync(dstDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello rclona');
  fs.writeFileSync(path.join(srcDir, 'sub', 'b.txt'), 'nested file');
  fs.writeFileSync(path.join(srcDir, 'c.bin'), Buffer.alloc(2048, 7));

  const env = {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: path.join(T, 'data'),
    RCLONE_BIN,
    RC_ADDR: '127.0.0.1:5599',
    PANEL_USER: 'tester',
    PANEL_PASSWORD: 'testpass123',
    TZ: 'Asia/Shanghai',
    HEALTH_DAILY_TIME: '23:59',
    HEALTH_RETRY_MS: '1200',
    HEALTH_FAIL_THRESHOLD: '3',
    TICK_MS: '800',
    TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`
  };
  let gwLog = '';
  let gw = null;
  function spawnGw() {
    const p = spawn('node', ['src/index.js'], { cwd: path.join(ROOT, 'gateway'), env, stdio: 'pipe' });
    p.stdout.on('data', (d) => { gwLog += d; });
    p.stderr.on('data', (d) => { gwLog += d; });
    return p;
  }
  gw = spawnGw();
  const tgSrv = await startFakeTelegram(TG_PORT);

  try {
    console.log('== 1. 启动与鉴权 ==');
    await waitFor(async () => (await api('GET', '/api/auth/me')).status === 200, 20000);
    ok(true, '网关启动成功');
    const unauth = await api('GET', '/api/remotes');
    ok(unauth.status === 401, '未登录访问 API 返回 401');
    const badLogin = await api('POST', '/api/auth/login', { user: 'tester', password: 'wrong' });
    ok(badLogin.status === 401, '错误密码登录被拒');
    const login = await api('POST', '/api/auth/login', { user: 'tester', password: 'testpass123' });
    ok(login.status === 200, '正确密码登录成功');

    console.log('== 1b. Telegram 通知配置与测试消息 ==');
    const putTg = await api('PUT', '/api/settings', {
      telegram: { enabled: true, botToken: 'TESTTOKEN123', chatId: '424242' }
    });
    ok(putTg.status === 200, 'Telegram 设置可保存');
    const getTg = await api('GET', '/api/settings');
    ok(getTg.data.botTokenSet === true && getTg.data.settings?.telegram?.chatId === '424242'
      && !JSON.stringify(getTg.data).includes('TESTTOKEN123'),
      '设置回读：令牌不回显明文、Chat ID 正确、无旧 SMTP 字段');
    const testTg = await api('POST', '/api/settings/test-telegram');
    ok(testTg.status === 200, '测试通知接口成功');
    const tgTest = tgMessages.find((m) => m.text.includes('测试通知'));
    ok(!!tgTest && tgTest.url === '/botTESTTOKEN123/sendMessage' && String(tgTest.chat_id) === '424242',
      '假 Telegram 服务器收到格式正确的测试消息', tgTest ? `url=${tgTest.url} chat=${tgTest.chat_id}` : '未收到');

    console.log('== 2. 创建本地目录网盘 ==');
    const r1 = await api('POST', '/api/remotes', { name: 'tsrc', type: 'local', config: {} });
    const r2 = await api('POST', '/api/remotes', { name: 'tdst', type: 'local', config: {} });
    ok(r1.status === 200 && r1.data.test?.ok, '源网盘创建且连接测试通过');
    ok(r2.status === 200 && r2.data.test?.ok, '目标网盘创建且连接测试通过');
    const prov = await api('GET', '/api/remotes/providers');
    const s3opts = prov.data.providers?.s3?.options || [];
    ok(s3opts.length > 10 && s3opts.some((o) => o.name === 'access_key_id'), 'providers 动态表单数据可用（S3 含 access_key_id）',
      `s3 字段 ${s3opts.length} 个`);
    const koofrPw = (prov.data.providers?.koofr?.options || []).find((o) => o.name === 'password');
    ok(koofrPw?.type === 'password', 'Koofr 密码字段被识别为 password 类型');

    console.log('== 2b. 本地网盘根目录浏览（#21：列的是文件系统根，不是网关工作目录）==');
    const bRoot = await api('GET', '/api/browse?remote=tsrc&path=%2F');
    ok(bRoot.status === 200, 'local 网盘 path=/ 浏览成功', `状态=${bRoot.status} ${bRoot.data?.error || ''}`);
    const rootDirs = bRoot.data?.dirs || [];
    const rootNames = rootDirs.map((d) => d.name);
    ok(rootNames.includes('tmp'), '根目录列出文件系统根（含 tmp，而非网关 CWD 的 src/test）', rootNames.slice(0, 10).join(','));
    ok(rootDirs.length > 0 && rootDirs.every((d) => d.path.startsWith('/')), '根下条目路径均为绝对路径（点子目录锚点一致）');
    const bRootEmpty = await api('GET', '/api/browse?remote=tsrc&path=');
    ok(bRootEmpty.status === 200 && (bRootEmpty.data?.dirs || []).some((d) => d.name === 'tmp'),
      'local 网盘 path=（空）同样落到文件系统根');
    const bTmp = await api('GET', '/api/browse?remote=tsrc&path=%2Ftmp');
    ok(bTmp.status === 200 && (bTmp.data?.dirs || []).some((d) => d.name === 'rclona-e2e'),
      '从根逐级点进 /tmp 可达且能看到自测目录', `状态=${bTmp.status} ${bTmp.data?.error || ''}`);

    console.log('== 3. 建任务并手动执行（真实 sync）==');
    const taskRes = await api('POST', '/api/tasks', {
      name: '自测备份', srcRemote: 'tsrc', srcPath: srcDir,
      dstRemote: 'tdst', dstPath: dstDir,
      schedule: { type: 'daily', time: '04:00' }
    });
    ok(taskRes.status === 200, '任务创建成功');
    const taskId = taskRes.data.task.id;
    await api('POST', `/api/tasks/${taskId}/run`);
    const run1 = await waitFor(async () => {
      const d = await api('GET', '/api/runs?limit=1');
      const r = d.data.runs?.[0];
      return r && r.status !== 'running' ? r : null;
    }, 60000);
    ok(run1.status === 'success', '首次备份成功', `状态=${run1.status} ${run1.reasonZh || ''}`);
    ok(run1.stages.every((s) => s.status === 'ok'), '五阶段全部 ok', run1.stages.map((s) => s.status).join(','));
    ok((run1.stats?.transferred ?? 0) >= 3, '传输文件数 ≥3', `实际 ${run1.stats?.transferred}`);
    ok(fs.readFileSync(path.join(dstDir, 'a.txt'), 'utf8') === 'hello rclona', '目标文件内容正确');
    ok(fs.existsSync(path.join(dstDir, 'sub', 'b.txt')), '嵌套文件已同步');

    console.log('== 4. 镜像语义：修改（同大小同时间戳）与删除都传染 ==');
    const aPath = path.join(srcDir, 'a.txt');
    const st = fs.statSync(aPath);
    fs.writeFileSync(aPath, 'hello rclonX'); // 同长度改内容
    fs.utimesSync(aPath, st.atime, st.mtime); // 时间戳拨回去：只有校验和能发现
    fs.rmSync(path.join(srcDir, 'sub', 'b.txt'));
    await api('POST', `/api/tasks/${taskId}/run`);
    const run2 = await waitFor(async () => {
      const d = await api('GET', '/api/runs?limit=1');
      const r = d.data.runs?.[0];
      return r && r.id !== run1.id && r.status !== 'running' ? r : null;
    }, 60000);
    ok(run2.status === 'success', '第二次备份成功');
    ok(fs.readFileSync(path.join(dstDir, 'a.txt'), 'utf8') === 'hello rclonX', '同大小同时间戳的内容变化被校验和发现并同步');
    ok(!fs.existsSync(path.join(dstDir, 'sub', 'b.txt')), '源删除的文件在目标被镜像删除');

    console.log('== 5. 失败阶段定位 ==');
    const badSrc = await api('POST', '/api/tasks', {
      name: '源不存在', srcRemote: 'tsrc', srcPath: '/no/such/dir',
      dstRemote: 'tdst', dstPath: dstDir, schedule: { type: 'daily', time: '04:00' }
    });
    await api('POST', `/api/tasks/${badSrc.data.task.id}/run`);
    const runBad1 = await waitFor(async () => {
      const d = await api('GET', '/api/runs?limit=5');
      const r = d.data.runs.find((x) => x.taskId === badSrc.data.task.id);
      return r && r.status !== 'running' ? r : null;
    }, 60000);
    ok(runBad1.status === 'failed' && runBad1.failedStage === 0, '源不存在 → 失败定位在阶段1（连接源网盘）',
      `阶段=${runBad1.failedStage} 原因=${runBad1.reasonZh}`);
    const tgFail = await waitFor(async () => tgHas('备份失败', '源不存在') || null, 10000).catch(() => null);
    ok(!!tgFail && tgHas('连接源网盘'), '备份失败已通过 Telegram 发出（带任务名与失败阶段）',
      tgFail ? '' : `已收到 ${tgMessages.length} 条：${tgMessages.map((m) => m.text.split('\n')[0]).join(' | ')}`);

    const filePath = path.join(T, 'afile.txt');
    fs.writeFileSync(filePath, 'i am a file');
    const badDst = await api('POST', '/api/tasks', {
      name: '目标是文件', srcRemote: 'tsrc', srcPath: srcDir,
      dstRemote: 'tdst', dstPath: filePath, schedule: { type: 'daily', time: '04:00' }
    });
    await api('POST', `/api/tasks/${badDst.data.task.id}/run`);
    const runBad2 = await waitFor(async () => {
      const d = await api('GET', '/api/runs?limit=8');
      const r = d.data.runs.find((x) => x.taskId === badDst.data.task.id);
      return r && r.status !== 'running' ? r : null;
    }, 60000);
    ok(runBad2.status === 'failed' && runBad2.failedStage === 2, '目标不可用 → 失败定位在阶段3（连接目标网盘）',
      `阶段=${runBad2.failedStage} 原因=${runBad2.reasonZh}`);
    ok(!!runBad2.reasonZh && !!runBad2.logExcerpt, '失败记录带中文原因与日志摘要');

    const handled = await api('POST', `/api/runs/${runBad2.id}/handle`);
    ok(handled.status === 200 && !!handled.data.run.handledAt, '失败记录可标记已处理');

    console.log('== 6. 网盘自检状态机 + 暂停语义 + Telegram 失效/恢复通知 ==');
    const DAVPORT = 18787;
    const bad = await api('POST', '/api/remotes', {
      name: 'tdav', type: 'webdav', config: { url: `http://127.0.0.1:${DAVPORT}/dav` }
    });
    ok(bad.status === 200 && bad.data.test?.ok === false, '假网盘创建（自动首测失败，进复测节奏）');
    const getRemote = async (n) => (await api('GET', '/api/remotes')).data.remotes.find((x) => x.name === n);

    // 6a 暂停：自检冻结（failCount 与 lastCheckAt 不再变化），且暂停网盘的任务跳过不算失败
    const pauseRes = await api('POST', '/api/remotes/tdav/pause');
    ok(pauseRes.status === 200 && pauseRes.data.paused === true, '网盘可暂停');
    ok((await getRemote('tdav'))?.paused === true, '网盘列表带 paused 标记');
    // 等可能在途的一次复测落定（failCount 到 2 或超时），之后数值应被冻结
    await waitFor(async () => {
      const r = await getRemote('tdav');
      return (r?.health?.failCount >= 2) ? r : null;
    }, 60000).catch(() => null);
    await sleep(22000); // 覆盖多个复测间隔：若暂停没生效，failCount 会继续涨到 3 并判 down
    const frozenA = await getRemote('tdav');
    await sleep(22000); // 再隔一段采样一次，两次一致才算真冻结（排除采样时正好有在途检查）
    const frozen2 = await getRemote('tdav');
    ok(frozenA.health.failCount === frozen2.health.failCount
      && frozenA.health.lastCheckAt === frozen2.health.lastCheckAt
      && frozen2.health.status !== 'down',
      '暂停期间自检被跳过（失败计数与检查时间冻结、未判失效）',
      `failCount ${frozenA.health.failCount} → ${frozen2.health.failCount}，状态=${frozen2.health.status}`);

    const skipTask = await api('POST', '/api/tasks', {
      name: '暂停跳过', srcRemote: 'tdav', srcPath: '',
      dstRemote: 'tdst', dstPath: dstDir, schedule: { type: 'daily', time: '04:00' }
    });
    await api('POST', `/api/tasks/${skipTask.data.task.id}/run`);
    const skipRun = await waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${skipTask.data.task.id}`);
      return d.data.runs?.[0] || null;
    }, 15000);
    ok(skipRun.status === 'skipped' && /已暂停/.test(skipRun.reasonZh || ''),
      '用到暂停网盘的任务被跳过并留记录（不算失败）', `状态=${skipRun.status} 原因=${skipRun.reasonZh}`);
    ok(!tgHas('备份失败', '暂停跳过'), '跳过不发失败 Telegram 通知');

    // 6b 恢复：继续复测 → 连败达阈值判失效并发 Telegram；服务上线后自动恢复并再发一条
    const resumeRes = await api('POST', '/api/remotes/tdav/resume');
    ok(resumeRes.status === 200 && resumeRes.data.paused === false, '网盘可恢复');
    const davDown = await waitFor(async () => {
      const r = await getRemote('tdav');
      return r?.health?.status === 'down' ? r : null;
    }, 150000); // 每次失败检查约 16s（rclone 对 WebDAV 的内部重试），放宽等待
    ok(true, '恢复后复测继续推进至「连接失效」（down）', `failCount=${davDown.health.failCount} 原因=${davDown.health.cause}`);
    const tgDown = await waitFor(async () => tgHas('网盘连接失效', 'tdav') || null, 10000).catch(() => null);
    ok(!!tgDown, '网盘失效已通过 Telegram 发出',
      tgDown ? '' : `已收到 ${tgMessages.length} 条：${tgMessages.map((m) => m.text.split('\n')[0]).join(' | ')}`);
    const davSrv = await startFakeDav(DAVPORT);
    const recovered = await waitFor(async () => {
      const r = await getRemote('tdav');
      return r?.health?.status === 'ok' ? r : null;
    }, 90000);
    ok(!!recovered, '假 WebDAV 上线后无需人工干预自动恢复为连接正常');
    const tgRec = await waitFor(async () => tgHas('网盘已恢复', 'tdav') || null, 10000).catch(() => null);
    ok(!!tgRec, '网盘恢复已通过 Telegram 发出',
      tgRec ? '' : `已收到 ${tgMessages.length} 条：${tgMessages.map((m) => m.text.split('\n')[0]).join(' | ')}`);
    davSrv.close();

    console.log('== 7. 概览聚合接口 ==');
    const ov = await api('GET', '/api/overview');
    ok(ov.status === 200 && ov.data.remotes.length >= 3 && ov.data.tasks.length >= 3, '概览返回网盘/任务/记录聚合',
      `网盘 ${ov.data.remotes.length} 个，任务 ${ov.data.tasks.length} 个`);

    console.log('== 8. 回归：目标目录不存在 → 执行备份时自动创建，首次备份成功 ==');
    const newDstPath = path.join(T, 'dstbase', 'auto-created', 'deep');
    ok(!fs.existsSync(newDstPath), '前置确认：目标目录尚不存在');
    const tAuto = await api('POST', '/api/tasks', {
      name: '目标自动创建', srcRemote: 'tsrc', srcPath: srcDir,
      dstRemote: 'tdst', dstPath: newDstPath, schedule: { type: 'daily', time: '04:00' }
    });
    ok(tAuto.status === 200, '目标目录不存在的任务可以创建');
    await api('POST', `/api/tasks/${tAuto.data.task.id}/run`);
    const runAuto = await waitFor(async () => {
      const d = await api('GET', '/api/runs?limit=50');
      const r = d.data.runs.find((x) => x.taskId === tAuto.data.task.id);
      return r && r.status !== 'running' ? r : null;
    }, 60000);
    ok(runAuto.status === 'success', '目标目录不存在时首次备份成功（不再卡在阶段3）',
      `状态=${runAuto.status} ${runAuto.reasonZh || ''}`);
    ok(fs.existsSync(path.join(newDstPath, 'a.txt')) &&
      fs.readFileSync(path.join(newDstPath, 'a.txt'), 'utf8') === fs.readFileSync(path.join(srcDir, 'a.txt'), 'utf8'),
      '目标目录被自动创建且文件同步到位');

    console.log('== 9. 回归：新建任务不补跑（从创建后的下一个计划时刻起执行）==');
    // 取网关时区（Asia/Shanghai）下约 70 分钟前的时间作为「已过」的计划时刻
    const shNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const shPast = new Date(shNow.getTime() - 70 * 60 * 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    const pastTime = `${p2(shPast.getHours())}:${p2(shPast.getMinutes())}`;
    const nowTime = `${p2(shNow.getHours())}:${p2(shNow.getMinutes())}`;
    const tLate = await api('POST', '/api/tasks', {
      name: '新建不补跑', srcRemote: 'tsrc', srcPath: srcDir,
      dstRemote: 'tdst', dstPath: dstDir, schedule: { type: 'daily', time: pastTime }
    });
    ok(tLate.status === 200, '计划时刻已过的任务创建成功', `计划时刻=${pastTime}，当前=${nowTime}`);
    await sleep(3000); // TICK_MS=800，至少等 3 个调度 tick
    const runsLate = await api('GET', `/api/runs?taskId=${tLate.data.task.id}`);
    ok((runsLate.data.runs || []).length === 0, '新建任务未被立即补跑（无运行记录）');
    const tasksNow = await api('GET', '/api/tasks');
    const lt = tasksNow.data.tasks.find((x) => x.id === tLate.data.task.id);
    const ltNext = lt?.nextRunAt ? new Date(new Date(lt.nextRunAt).toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })) : null;
    ok(!!ltNext && ltNext > shNow && `${p2(ltNext.getHours())}:${p2(ltNext.getMinutes())}` === pastTime,
      '下一次执行已排到明天的同一时刻', `nextRunAt=${lt?.nextRunAt}`);

    console.log('== 10. 新计划类型：nextRunAt 计算与校验 ==');
    const hmOf = (iso) => {
      const d = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
      return { str: `${p2(d.getHours())}:${p2(d.getMinutes())}`, day: d.getDay(), date: d.getDate(), d };
    };
    const mkTask = async (name, schedule) => {
      const r = await api('POST', '/api/tasks', {
        name, srcRemote: 'tsrc', srcPath: srcDir, dstRemote: 'tdst', dstPath: dstDir, schedule
      });
      return r;
    };
    // 每月
    const tMon = await mkTask('计划-每月', { type: 'monthly', time: '03:00', dayOfMonth: 1 });
    const monNext = tMon.data.task?.nextRunAt ? hmOf(tMon.data.task.nextRunAt) : null;
    ok(tMon.status === 200 && !!monNext && monNext.date === 1 && monNext.str === '03:00'
      && new Date(tMon.data.task.nextRunAt) > new Date(),
      '每月：下一次落在 1 号 03:00 且在未来', `nextRunAt=${tMon.data.task?.nextRunAt}`);
    // 每周多选
    const tWeek = await mkTask('计划-每周多选', { type: 'weekly', time: '03:30', weekdays: [5, 1, 3] });
    const weekNext = tWeek.data.task?.nextRunAt ? hmOf(tWeek.data.task.nextRunAt) : null;
    ok(tWeek.status === 200 && !!weekNext && [1, 3, 5].includes(weekNext.day) && weekNext.str === '03:30'
      && JSON.stringify(tWeek.data.task.schedule.weekdays) === '[1,3,5]',
      '每周多选：星期被排序保存、下一次落在所选星期', `nextRunAt=${tWeek.data.task?.nextRunAt} 周${weekNext?.day}`);
    // 每隔 N 小时（锚点 = 创建时间）
    const tHours = await mkTask('计划-每隔小时', { type: 'hours', intervalHours: 6 });
    const hoursDiff = tHours.data.task ? (new Date(tHours.data.task.nextRunAt) - new Date(tHours.data.task.createdAt)) : 0;
    ok(tHours.status === 200 && Math.abs(hoursDiff - 6 * 3600000) < 5000,
      '每隔 N 小时：下一次 = 创建时间 + 6 小时', `diff=${Math.round(hoursDiff / 1000)}s`);
    await sleep(2500);
    const runsHours = await api('GET', `/api/runs?taskId=${tHours.data.task.id}`);
    ok((runsHours.data.runs || []).length === 0, '每隔 N 小时：新建后不立即执行');
    // 每隔 N 天
    const tDays = await mkTask('计划-每隔天', { type: 'days', time: '04:00', intervalDays: 3 });
    const daysNext = tDays.data.task?.nextRunAt ? hmOf(tDays.data.task.nextRunAt) : null;
    const anchorDay = new Date(new Date(tDays.data.task.createdAt).toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const dayDiff = daysNext ? Math.round((new Date(daysNext.d.toDateString()) - new Date(anchorDay.toDateString())) / 86400000) : -1;
    ok(tDays.status === 200 && !!daysNext && daysNext.str === '04:00' && dayDiff % 3 === 0
      && new Date(tDays.data.task.nextRunAt) > new Date(),
      '每隔 N 天：下一次在锚点日期 + 3 的倍数天、04:00', `nextRunAt=${tDays.data.task?.nextRunAt} 相隔 ${dayDiff} 天`);
    // cron
    const tCron = await mkTask('计划-cron', { type: 'cron', cron: '*/30 * * * *' });
    const cronNextMs = tCron.data.task?.nextRunAt ? new Date(tCron.data.task.nextRunAt).getTime() : 0;
    const cronHm = tCron.data.task?.nextRunAt ? hmOf(tCron.data.task.nextRunAt) : null;
    ok(tCron.status === 200 && cronNextMs > Date.now() && cronNextMs - Date.now() <= 30 * 60000 + 5000
      && cronHm && Number(cronHm.str.split(':')[1]) % 30 === 0,
      'cron：下一次落在下一个半点刻度内', `nextRunAt=${tCron.data.task?.nextRunAt}`);
    const badCron = await mkTask('计划-cron非法', { type: 'cron', cron: '99 * * * *' });
    ok(badCron.status !== 200 && /cron/.test(badCron.data?.error || ''),
      'cron 非法表达式被拒绝', `status=${badCron.status} err=${badCron.data?.error || ''}`);

    console.log('== 11. 概览新字段：累计计数与系统信息 ==');
    const ov2 = await api('GET', '/api/overview');
    const ovStats = ov2.data.stats || {};
    ok(ovStats.runs === 5 && ovStats.success === 3 && ovStats.failed === 2,
      '累计计数正确（成功 3 + 失败 2，跳过不计）', JSON.stringify(ovStats));
    ok(ovStats.bytes > 0 && ovStats.files >= 3 && ovStats.lastRunFiles === runAuto.stats?.transferred,
      '累计传输量/文件数与最近一次文件数正确', `bytes=${ovStats.bytes} files=${ovStats.files} lastRunFiles=${ovStats.lastRunFiles}`);
    ok(!!ov2.data.system?.rcloneVersion && !!ov2.data.system?.startedAt && !!ov2.data.system?.nextHealthCheckAt,
      '系统信息齐全（rclone 版本/启动时间/下次自检）', JSON.stringify(ov2.data.system));
    ok(ov2.data.tasks.every((t) => 'nextRunAt' in t), '每个任务都带 nextRunAt');

    console.log('== 12. 老数据迁移：旧计划结构与旧设置在重启后被归一化 ==');
    gw.kill('SIGTERM');
    await sleep(1200);
    gw.kill('SIGKILL');
    const dataFile = path.join(T, 'data', 'rclona.json');
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    saved.tasks.push({
      id: 'legacy-task-1', name: '老任务迁移', srcRemote: 'tsrc', srcPath: srcDir,
      dstRemote: 'tdst', dstPath: dstDir, enabled: true,
      createdAt: threeDaysAgo, lastRunAt: threeDaysAgo, lastStatus: 'success', lastSlotKey: '',
      schedule: { type: 'weekly', time: '05:00', weekday: 2 }
    });
    saved.settings = { notify: { enabled: true, to: 'old@example.com' }, smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'u', pass: 'p' } };
    fs.writeFileSync(dataFile, JSON.stringify(saved, null, 2));
    cookie = ''; // 会话是内存态，重启后要重新登录
    gw = spawnGw();
    await waitFor(async () => (await api('GET', '/api/auth/me')).status === 200, 20000);
    const relogin = await api('POST', '/api/auth/login', { user: 'tester', password: 'testpass123' });
    ok(relogin.status === 200, '重启后可重新登录');
    const tasksAfter = await api('GET', '/api/tasks');
    const legacy = tasksAfter.data.tasks.find((t) => t.id === 'legacy-task-1');
    ok(!!legacy && JSON.stringify(legacy.schedule.weekdays) === '[2]' && !!legacy.anchorAt && !!legacy.nextRunAt,
      '老 weekly 任务被迁移（weekday → weekdays、补 anchorAt 与 nextRunAt）',
      legacy ? JSON.stringify(legacy.schedule) + ` next=${legacy.nextRunAt}` : '任务丢了');
    const settingsAfter = await api('GET', '/api/settings');
    ok(!!settingsAfter.data.settings?.telegram && !('smtp' in settingsAfter.data.settings) && settingsAfter.data.botTokenSet === false,
      '旧邮箱/SMTP 设置被丢弃、改为 Telegram 结构（令牌未设置）');

    console.log('== 13. 第二批：面板地址与通知直达链接 / 紧凑记录字段 / /host 自动排除 ==');
    // 13a 面板地址：保存时去掉末尾斜杠；非法地址整单拒绝且不改动原设置
    const putAddr = await api('PUT', '/api/settings', {
      telegram: { enabled: true, botToken: 'TESTTOKEN123', chatId: '424242', panelAddress: 'http://panel.example.com:8080/' }
    });
    ok(putAddr.status === 200, '带面板地址的设置可保存');
    const getAddr = await api('GET', '/api/settings');
    ok(getAddr.data.settings?.telegram?.panelAddress === 'http://panel.example.com:8080',
      '面板地址回读正确（末尾斜杠已去掉）', getAddr.data.settings?.telegram?.panelAddress || '(空)');
    const putBadAddr = await api('PUT', '/api/settings', {
      telegram: { enabled: true, botToken: 'TESTTOKEN123', chatId: '424242', panelAddress: '这不是网址' }
    });
    ok(putBadAddr.status === 400 && /面板访问地址/.test(putBadAddr.data?.error || ''),
      '非法面板地址被拒绝（400）', putBadAddr.data?.error || '');
    const getAddr2 = await api('GET', '/api/settings');
    ok(getAddr2.data.settings?.telegram?.panelAddress === 'http://panel.example.com:8080',
      '非法地址被拒后，原设置未被改动');

    // 13b 失败通知末尾带记录直达链接；记录自带紧凑展示字段
    const linkTask = await api('POST', '/api/tasks', {
      name: '链接通知', srcRemote: 'tsrc', srcPath: '/no/such/dir2',
      dstRemote: 'tdst', dstPath: dstDir, schedule: { type: 'daily', time: '04:00' }
    });
    await api('POST', `/api/tasks/${linkTask.data.task.id}/run`);
    const linkRun = await waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${linkTask.data.task.id}`);
      const r = d.data.runs?.[0];
      return r && r.status === 'failed' ? r : null;
    }, 60000);
    ok(!!linkRun, '链接通知任务按预期失败（源不存在）');
    ok(typeof linkRun.reasonZh === 'string' && linkRun.reasonZh.length > 0
      && !!linkRun.failedStageLabel && Array.isArray(linkRun.stages) && !!linkRun.startedAt,
      '记录自带紧凑行展示所需字段（状态/任务名/时间/简要原因/失败阶段/五阶段）');
    const tgLink = await waitFor(async () =>
      tgMessages.find((m) => m.text.includes('链接通知')
        && m.text.includes(`http://panel.example.com:8080/runs?focus=${linkRun.id}`)) || null, 10000).catch(() => null);
    ok(!!tgLink, '失败通知末尾带正确的记录直达链接',
      tgLink ? '' : `已收到 ${tgMessages.length} 条，未找到带链接的那条`);

    // 13c 清空面板地址：通知照常发送，但不再带链接
    const putNoAddr = await api('PUT', '/api/settings', {
      telegram: { enabled: true, chatId: '424242', panelAddress: '' }
    });
    ok(putNoAddr.status === 200, '清空面板地址可保存（令牌留空=不改，靠它继续发通知）');
    const tgBefore = tgMessages.length;
    const noLinkTask = await api('POST', '/api/tasks', {
      name: '无链接通知', srcRemote: 'tsrc', srcPath: '/no/such/dir3',
      dstRemote: 'tdst', dstPath: dstDir, schedule: { type: 'daily', time: '04:00' }
    });
    await api('POST', `/api/tasks/${noLinkTask.data.task.id}/run`);
    const tgNoLink = await waitFor(async () =>
      tgMessages.slice(tgBefore).find((m) => m.text.includes('无链接通知') && m.text.includes('备份失败')) || null, 15000).catch(() => null);
    ok(!!tgNoLink && !tgNoLink.text.includes('focus='),
      '未填面板地址时通知照常发送且不带链接');

    // 13d 备份源 = /host 根目录：proc/sys/dev/run 自动排除（同步与校验一致），真实文件正常同步
    const HOST = '/host';
    if (!fs.existsSync(HOST)) {
      for (const d of ['proc', 'sys', 'dev', 'run', 'etc', 'home']) fs.mkdirSync(path.join(HOST, d), { recursive: true });
      for (const d of ['proc', 'sys', 'dev', 'run']) fs.writeFileSync(path.join(HOST, d, 'junk.txt'), 'virtual junk');
      fs.writeFileSync(path.join(HOST, 'etc', 'hostname.txt'), 'my-vps');
      fs.writeFileSync(path.join(HOST, 'home', 'note.txt'), 'important note');
      try {
        const thost = await api('POST', '/api/remotes', { name: 'thost', type: 'local', config: {} });
        ok(thost.status === 200, '宿主机本地网盘（local）创建成功');
        const hostDst = path.join(T, 'hostbak');
        const hostTask = await api('POST', '/api/tasks', {
          name: '服务器根目录备份', srcRemote: 'thost', srcPath: HOST,
          dstRemote: 'tdst', dstPath: hostDst, schedule: { type: 'daily', time: '04:00' }
        });
        await api('POST', `/api/tasks/${hostTask.data.task.id}/run`);
        const hostRun = await waitFor(async () => {
          const d = await api('GET', `/api/runs?taskId=${hostTask.data.task.id}`);
          const r = d.data.runs?.[0];
          return r && r.status !== 'running' ? r : null;
        }, 60000);
        ok(hostRun.status === 'success', '/host 备份成功（校验阶段也通过：排除在同步与校验两侧一致）',
          `状态=${hostRun.status} ${hostRun.reasonZh || ''}`);
        ok(fs.readFileSync(path.join(hostDst, 'etc', 'hostname.txt'), 'utf8') === 'my-vps'
          && fs.readFileSync(path.join(hostDst, 'home', 'note.txt'), 'utf8') === 'important note',
          '/host 下的真实文件已正确同步');
        ok(!fs.existsSync(path.join(hostDst, 'proc')) && !fs.existsSync(path.join(hostDst, 'sys'))
          && !fs.existsSync(path.join(hostDst, 'dev')) && !fs.existsSync(path.join(hostDst, 'run')),
          'proc/sys/dev/run 虚拟目录被自动排除（未出现在目标）');
        ok(/已自动排除/.test(hostRun.logExcerpt || ''), '运行日志里注明了自动排除');
      } finally {
        fs.rmSync(HOST, { recursive: true, force: true });
      }
    } else {
      ok(true, '（跳过 /host 排除用例：本机已存在 /host，不动它）');
    }

    console.log('== 14. 热修 #15：网盘可编辑 / 分类器分清凭证与权限 / S3 单桶令牌不误判 ==');
    // 14a 分类器：用真实错误文本样本断言归类（AccessDenied 绝不能再归「凭证错误」）
    ok(classifyError('operation error S3: ListBuckets, StatusCode: 403, api error InvalidAccessKeyId: The AWS Access Key Id you provided does not exist').kind === 'auth',
      'InvalidAccessKeyId → 真凭证错误');
    ok(classifyError('operation error S3: PutObject, api error SignatureDoesNotMatch: The request signature we calculated does not match').kind === 'auth',
      'SignatureDoesNotMatch → 真凭证错误');
    ok(classifyError('api error InvalidClientTokenId: The security token included in the request is invalid').kind === 'auth',
      'InvalidClientTokenId → 真凭证错误');
    const deniedCls = classifyError('Failed to ls: operation error S3: ListBuckets, https response error StatusCode: 403, api error AccessDenied: Access Denied');
    ok(deniedCls.kind === 'permission' && !/凭证不正确/.test(deniedCls.reasonZh),
      'AccessDenied(403) → 权限不足（与凭证错误分开）', deniedCls.reasonZh);
    ok(classifyError('401 Unauthorized').kind === 'auth', '401 → 凭证错误');

    // 14b 编辑网盘：普通字段可改、密钥留空不被冲掉、密钥不外泄
    const EDITDAV = 18788;
    const editDavSrv = await startFakeDav(EDITDAV);
    const confPath = path.join(T, 'data', 'rclone.conf');
    const passLineOf = (sec) => {
      const txt = fs.readFileSync(confPath, 'utf8');
      const m = txt.match(new RegExp(`\\[${sec}\\][\\s\\S]*?^pass = (.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    try {
      const mk = await api('POST', '/api/remotes', {
        name: 'editdav', type: 'webdav',
        config: { url: `http://127.0.0.1:${EDITDAV}/dav`, user: 'u1', pass: 'pw-one' }
      });
      ok(mk.status === 200 && mk.data.test?.ok === true, '待编辑网盘创建并首测通过');
      const passBefore = passLineOf('editdav');
      ok(!!passBefore, '前置：conf 里已有加密保存的密码');
      const getCfg = await api('GET', '/api/remotes/editdav/config');
      ok(getCfg.status === 200 && getCfg.data.config?.user === 'u1'
        && !('pass' in (getCfg.data.config || {})) && (getCfg.data.secrets || []).includes('pass'),
        '读取配置：普通字段回填、密码字段不下发');
      ok(!JSON.stringify(getCfg.data).includes(passBefore), '读取配置的响应里不含已存密码（连加密串也不给）');
      const putKeep = await api('PUT', '/api/remotes/editdav/config', {
        config: { url: `http://127.0.0.1:${EDITDAV}/dav`, user: 'u2', pass: '' }
      });
      ok(putKeep.status === 200 && putKeep.data.test?.ok === true, '编辑保存（密码留空）成功且重测通过',
        putKeep.status !== 200 ? `status=${putKeep.status} ${JSON.stringify(putKeep.data)}` : '');
      ok(passLineOf('editdav') === passBefore, '密码留空保存后，已存密码未被冲掉（conf 里原样保留）');
      const getCfg2 = await api('GET', '/api/remotes/editdav/config');
      ok(getCfg2.data.config?.user === 'u2', '普通字段修改已生效（user 改为 u2）');
      const putNew = await api('PUT', '/api/remotes/editdav/config', { config: { pass: 'pw-two' } });
      ok(putNew.status === 200 && passLineOf('editdav') !== passBefore && passLineOf('editdav') !== '',
        '填了新密码保存后，已存密码被更新',
        putNew.status !== 200 ? `status=${putNew.status} ${JSON.stringify(putNew.data)}` : '');
      const put404 = await api('PUT', '/api/remotes/no-such-remote/config', { config: { user: 'x' } });
      ok(put404.status === 404, '编辑不存在的网盘返回 404');
      const get404 = await api('GET', '/api/remotes/no-such-remote/config');
      ok(get404.status === 404, '读取不存在网盘的配置返回 404');
    } finally { editDavSrv.close(); }

    // 14c 假 S3 单桶令牌：根 ListBuckets 被 403 AccessDenied → 判已连通 + remark，浏览根目录给 permission 码、按桶名可列
    const s3DeniedSrv = await startFakeS3(18791, 'denied');
    const s3BadSrv = await startFakeS3(18792, 'badkey');
    try {
      const mkS3 = await api('POST', '/api/remotes', {
        name: 'fakes3', type: 's3',
        config: { provider: 'Other', access_key_id: 'ak-test', secret_access_key: 'sk-test', region: 'us-east-1', endpoint: 'http://127.0.0.1:18791' }
      });
      ok(mkS3.status === 200 && mkS3.data.test?.ok === true && /单桶/.test(mkS3.data.test?.remark || ''),
        '单桶令牌创建首测判「已连通」并带单桶说明', JSON.stringify(mkS3.data.test || {}));
      const s3Remote = (await api('GET', '/api/remotes')).data.remotes.find((x) => x.name === 'fakes3');
      ok(s3Remote?.health?.status === 'ok' && /单桶/.test(s3Remote?.health?.remark || ''),
        '网盘列表里单桶网盘状态为 ok（绿）且带 remark');
      const browseRoot = await api('GET', '/api/browse?remote=fakes3&path=');
      ok(browseRoot.status === 400 && browseRoot.data?.code === 'permission',
        '浏览单桶网盘根目录返回 permission 码（前端据此给手动输入路径）', browseRoot.data?.error || '');
      const browseBucket = await api('GET', '/api/browse?remote=fakes3&path=webdav');
      ok(browseBucket.status === 200, '按桶名手动进入后可正常列目录（单桶令牌本就能用）');

      const mkBad = await api('POST', '/api/remotes', {
        name: 'bads3', type: 's3',
        config: { provider: 'Other', access_key_id: 'ak-bad', secret_access_key: 'sk-bad', region: 'us-east-1', endpoint: 'http://127.0.0.1:18792' }
      });
      ok(mkBad.status === 200 && mkBad.data.test?.ok === false && /凭证/.test(mkBad.data.test?.cause || ''),
        '真坏密钥仍判失败且原因指向凭证', mkBad.data.test?.cause || '');
      const badRemote = (await api('GET', '/api/remotes')).data.remotes.find((x) => x.name === 'bads3');
      ok(badRemote?.health?.status !== 'ok' && !badRemote?.health?.remark,
        '真坏密钥网盘不被误判为 ok、无单桶 remark');
    } finally { s3DeniedSrv.close(); s3BadSrv.close(); }

    console.log('== 15. 热修 #18：同名空占位自动跳过 / Koofr 400 分类 / 失败部分统计如实记账 ==');
    // 15a 分类器：Koofr 复制 400 错误 → 「冲突」类白话原因，不再落「未知原因」
    const koofrCls = classifyError('2026/10/23 09:03:46 ERROR : appdata/legado: Failed to copy: Invalid response status! Got 400, expected [200]; content length 0');
    ok(koofrCls.kind === 'conflict' && /拒绝写入/.test(koofrCls.reasonZh) && /同名/.test(koofrCls.reasonZh),
      'Koofr「Failed to copy: Invalid response status! Got 400」→ 目标拒绝写入（同名冲突）', koofrCls.reasonZh);
    ok(classifyError('Failed to copy: Invalid response status! Got 503, expected [200]').kind === 'conflict',
      'Invalid response status + Got 5xx 变体同样归冲突类');

    // 15b 占位复现：memory 后端能让「0 字节文件」与「同名目录」并存（本地磁盘造不出来），
    // 分三步把 fixture 灌进同一个 rcd 的 memory 网盘，再走面板任务全流程验证自动跳过
    const rcdCall = async (m, p) => {
      const r = await fetch(`http://127.0.0.1:5599/${m}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p)
      });
      return r.json();
    };
    const stA = path.join(T, 'stageA'); // appdata/legado（0 字节占位文件）、appdata/empty.txt（普通 0 字节文件，不能误跳）
    const stB = path.join(T, 'stageB'); // appdata/legado/inner.txt、appdata/legado/bookProgress/deep.txt、appdata/other.txt
    const stC = path.join(T, 'stageC'); // bookProgress（0 字节）→ 灌到 appdata/legado/ 下，形成第二层占位
    fs.mkdirSync(path.join(stA, 'appdata'), { recursive: true });
    fs.mkdirSync(path.join(stB, 'appdata', 'legado', 'bookProgress'), { recursive: true });
    fs.mkdirSync(stC, { recursive: true });
    fs.writeFileSync(path.join(stA, 'appdata', 'legado'), '');
    fs.writeFileSync(path.join(stA, 'appdata', 'empty.txt'), '');
    fs.writeFileSync(path.join(stB, 'appdata', 'legado', 'inner.txt'), 'realdata');
    fs.writeFileSync(path.join(stB, 'appdata', 'legado', 'bookProgress', 'deep.txt'), 'deepdata');
    fs.writeFileSync(path.join(stB, 'appdata', 'other.txt'), 'other');
    fs.writeFileSync(path.join(stC, 'bookProgress'), '');
    const memRes = await api('POST', '/api/remotes', { name: 'tmem', type: 'memory', config: {} });
    ok(memRes.status === 200, 'memory 网盘创建成功（与网关共用同一 rcd 进程）');
    await rcdCall('sync/copy', { srcFs: stC, dstFs: 'tmem:appdata/legado' });
    await rcdCall('sync/copy', { srcFs: stA, dstFs: 'tmem:' });
    await rcdCall('sync/copy', { srcFs: stB, dstFs: 'tmem:' });
    const memList = await rcdCall('operations/list', { fs: 'tmem:', remote: '', opt: { recurse: true } });
    const legadoAsFile = (memList.list || []).find((e) => e.Path === 'appdata/legado' && !e.IsDir && e.Size === 0);
    const legadoAsDir = (memList.list || []).find((e) => e.Path === 'appdata/legado' && e.IsDir);
    const bpAsFile = (memList.list || []).find((e) => e.Path === 'appdata/legado/bookProgress' && !e.IsDir && e.Size === 0);
    ok(!!legadoAsFile && !!legadoAsDir && !!bpAsFile,
      '前置：源里两处占位形态已复现（0 字节文件与同名目录并存，含嵌套一层）');
    const phDst = path.join(T, 'phbak');
    const phTask = await api('POST', '/api/tasks', {
      name: '占位跳过', srcRemote: 'tmem', srcPath: '',
      dstRemote: 'tdst', dstPath: phDst, schedule: { type: 'daily', time: '04:00' }
    });
    await api('POST', `/api/tasks/${phTask.data.task.id}/run`);
    const phRun = await waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${phTask.data.task.id}`);
      const r = d.data.runs?.[0];
      return r && r.status !== 'running' ? r : null;
    }, 60000);
    ok(phRun.status === 'success', '含同名占位的备份成功（不再被空占位绊倒判失败）',
      `状态=${phRun.status} ${phRun.reasonZh || ''}`);
    ok(fs.readFileSync(path.join(phDst, 'appdata', 'legado', 'inner.txt'), 'utf8') === 'realdata'
      && fs.readFileSync(path.join(phDst, 'appdata', 'legado', 'bookProgress', 'deep.txt'), 'utf8') === 'deepdata'
      && fs.readFileSync(path.join(phDst, 'appdata', 'other.txt'), 'utf8') === 'other',
      '占位同名目录里的真文件全部同步到位（精确排除没误伤目录）');
    ok(fs.existsSync(path.join(phDst, 'appdata', 'empty.txt'))
      && fs.statSync(path.join(phDst, 'appdata', 'empty.txt')).size === 0,
      '普通 0 字节文件（无同名目录）照常同步、未被误跳');
    ok(fs.statSync(path.join(phDst, 'appdata', 'legado')).isDirectory()
      && fs.statSync(path.join(phDst, 'appdata', 'legado', 'bookProgress')).isDirectory(),
      '目标端两处占位位置都是目录（空文件没有占位成功）');
    ok(/已自动跳过 2 个空占位对象（0 字节、与文件夹同名）/.test(phRun.logExcerpt || '')
      && (phRun.logExcerpt || '').includes('appdata/legado')
      && (phRun.logExcerpt || '').includes('appdata/legado/bookProgress'),
      '运行日志注明跳过了 2 个空占位并列出路径');

    // 15c 传输中途失败：已传部分如实记入记录与全局统计（以前一律记 0）
    const fSrc = path.join(T, 'failsrc');
    const fDst = path.join(T, 'faildst');
    fs.mkdirSync(path.join(fSrc, 'sub'), { recursive: true });
    fs.mkdirSync(fDst, { recursive: true });
    fs.writeFileSync(path.join(fSrc, 'top1.txt'), 'aaaa');
    fs.writeFileSync(path.join(fSrc, 'top2.txt'), 'bbbbbb');
    fs.writeFileSync(path.join(fSrc, 'sub', 'inner.txt'), 'inner');
    fs.writeFileSync(path.join(fDst, 'sub'), '我是挡路的文件'); // 目标端同名位置是个文件，sub/inner.txt 必然传不过去
    const statsBefore = (await api('GET', '/api/overview')).data.stats;
    const fTask = await api('POST', '/api/tasks', {
      name: '中途失败', srcRemote: 'tsrc', srcPath: fSrc,
      dstRemote: 'tdst', dstPath: fDst, schedule: { type: 'daily', time: '04:00' }
    });
    await api('POST', `/api/tasks/${fTask.data.task.id}/run`);
    const fRun = await waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${fTask.data.task.id}`);
      const r = d.data.runs?.[0];
      return r && r.status !== 'running' ? r : null;
    }, 60000);
    ok(fRun.status === 'failed' && fRun.failedStage === 3, '传输中途失败 → 定位在阶段4（传输文件）',
      `状态=${fRun.status} 阶段=${fRun.failedStage} 原因=${fRun.reasonZh}`);
    ok((fRun.stats?.transferred ?? 0) >= 2 && (fRun.stats?.bytes ?? 0) > 0,
      '失败记录里记下了已传文件数与字节数（不再是 0）',
      `transferred=${fRun.stats?.transferred} bytes=${fRun.stats?.bytes}`);
    const statsAfter = (await api('GET', '/api/overview')).data.stats;
    ok(statsAfter.files === statsBefore.files + (fRun.stats?.transferred || 0)
      && statsAfter.bytes === statsBefore.bytes + (fRun.stats?.bytes || 0),
      '全局累计文件数/字节数把失败的已传部分也算了进去',
      `files ${statsBefore.files}→${statsAfter.files}，bytes ${statsBefore.bytes}→${statsAfter.bytes}`);

    console.log('== 16. #25：一个任务多组文件夹映射 + 老任务自动迁移 ==');
    // 16a 迁移：第 12 节注入的 legacy-task-1 只有 srcPath/dstPath，重启迁移后应带 pairs 且与老字段一致
    const tasks16 = await api('GET', '/api/tasks');
    const legacy16 = tasks16.data.tasks.find((t) => t.id === 'legacy-task-1');
    ok(!!legacy16 && Array.isArray(legacy16.pairs) && legacy16.pairs.length === 1
      && legacy16.pairs[0].src === srcDir && legacy16.pairs[0].dst === dstDir
      && legacy16.srcPath === srcDir && legacy16.dstPath === dstDir,
      '老单组任务自动迁移为 pairs（src/dst 与原 srcPath/dstPath 一致，镜像字段保留）',
      JSON.stringify(legacy16?.pairs));

    // 16b 多组任务真跑：两组不同源目录 → 两个不同目标目录，各就各位
    const mSrc1 = path.join(T, 'multi', 'docs');
    const mSrc2 = path.join(T, 'multi', 'pics');
    const mDst1 = path.join(T, 'multibak', 'docs');
    const mDst2 = path.join(T, 'multibak', 'pics');
    fs.mkdirSync(mSrc1, { recursive: true });
    fs.mkdirSync(mSrc2, { recursive: true });
    fs.writeFileSync(path.join(mSrc1, 'report.txt'), 'doc-content');
    fs.writeFileSync(path.join(mSrc2, 'photo.txt'), 'pic-content');
    fs.writeFileSync(path.join(mSrc2, 'photo2.txt'), 'pic-content-2');
    const mTask = await api('POST', '/api/tasks', {
      name: '多组映射', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: mSrc1, dst: mDst1 }, { src: mSrc2, dst: mDst2 }],
      schedule: { type: 'daily', time: '04:00' }
    });
    ok(mTask.status === 200 && mTask.data.task.pairs?.length === 2
      && mTask.data.task.srcPath === mSrc1 && mTask.data.task.dstPath === mDst1,
      '多组任务创建成功（pairs 保存、srcPath 镜像为第一组）', `status=${mTask.status}`);
    await api('POST', `/api/tasks/${mTask.data.task.id}/run`);
    const mRun = await waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${mTask.data.task.id}`);
      const r = d.data.runs?.[0];
      return r && r.status !== 'running' ? r : null;
    }, 60000);
    ok(mRun.status === 'success', '多组任务整体成功（全部组成功才算成功）',
      `状态=${mRun.status} ${mRun.reasonZh || ''}`);
    ok(fs.readFileSync(path.join(mDst1, 'report.txt'), 'utf8') === 'doc-content'
      && fs.readFileSync(path.join(mDst2, 'photo.txt'), 'utf8') === 'pic-content'
      && fs.readFileSync(path.join(mDst2, 'photo2.txt'), 'utf8') === 'pic-content-2',
      '两组的文件各就各位（组1到目标1、组2到目标2）');
    ok(Array.isArray(mRun.pairs) && mRun.pairs.length === 2 && mRun.pairs.every((x) => x.status === 'success'),
      '运行记录带每组结果（2 组均为 success）');
    ok((mRun.stats?.transferred ?? 0) >= 3, '统计按全部组汇总（文件数 ≥3）',
      `transferred=${mRun.stats?.transferred}`);
    ok(/第 1 组/.test(mRun.logExcerpt || '') && /第 2 组/.test(mRun.logExcerpt || ''),
      '日志按组分段（有第 1 组 / 第 2 组小节）');

    // 16c 一组失败不阻断另一组：记录为失败、写明失败组与阶段，成功组文件已到位
    const mixDstOk = path.join(T, 'multibak', 'ok-side');
    const mixTask = await api('POST', '/api/tasks', {
      name: '多组一组失败', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: '/no/such/multi-dir', dst: path.join(T, 'multibak', 'bad-side') }, { src: mSrc1, dst: mixDstOk }],
      schedule: { type: 'daily', time: '04:00' }
    });
    await api('POST', `/api/tasks/${mixTask.data.task.id}/run`);
    const mixRun = await waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${mixTask.data.task.id}`);
      const r = d.data.runs?.[0];
      return r && r.status !== 'running' ? r : null;
    }, 60000);
    ok(mixRun.status === 'failed' && mixRun.failedStage === 0,
      '一组失败 → 整体记录为失败、失败阶段取第一处失败（阶段1）',
      `状态=${mixRun.status} 阶段=${mixRun.failedStage} 原因=${mixRun.reasonZh}`);
    ok(/第 1 组/.test(mixRun.reasonZh || '') && mixRun.pairs?.[0]?.status === 'failed'
      && mixRun.pairs?.[1]?.status === 'success',
      '记录里写清失败的是哪一组、另一组为成功', mixRun.reasonZh || '');
    ok(fs.readFileSync(path.join(mixDstOk, 'report.txt'), 'utf8') === 'doc-content',
      '失败组没有阻断后面组：成功组文件已到位');
    ok((mixRun.stats?.transferred ?? 0) >= 1, '混合成败时统计仍汇总成功组已传文件',
      `transferred=${mixRun.stats?.transferred}`);

    // 16d 校验：pairs 给了就必须非空
    const emptyPairs = await api('POST', '/api/tasks', {
      name: '空映射', srcRemote: 'tsrc', dstRemote: 'tdst', pairs: [],
      schedule: { type: 'daily', time: '04:00' }
    });
    ok(emptyPairs.status !== 200 && /至少要有一组/.test(emptyPairs.data?.error || ''),
      'pairs 为空数组被拒绝（中文提示）', emptyPairs.data?.error || '');

    console.log('== 17. #24：定时备份首次成功才发 Telegram，手动不发、只发一次 ==');
    // 设置带面板地址，便于一并验证首次成功通知里的记录直达链接
    await api('PUT', '/api/settings', {
      telegram: { enabled: true, botToken: 'TESTTOKEN123', chatId: '424242', panelAddress: 'http://panel.example.com:8080' }
    });
    const scSrc = path.join(T, 'sched', 'data');
    const scDst = path.join(T, 'sched', 'bak');
    fs.mkdirSync(scSrc, { recursive: true });
    fs.writeFileSync(path.join(scSrc, 'hello.txt'), 'scheduled hello');
    const scTask = await api('POST', '/api/tasks', {
      name: '定时首成功', srcRemote: 'tsrc', srcPath: scSrc,
      dstRemote: 'tdst', dstPath: scDst, schedule: { type: 'daily', time: '04:00' }
    });
    const scBad = await api('POST', '/api/tasks', {
      name: '定时坏任务', srcRemote: 'tsrc', srcPath: '/no/such/sched-dir',
      dstRemote: 'tdst', dstPath: scDst, schedule: { type: 'daily', time: '04:00' }
    });
    const firstOkMsgs = () => tgMessages.filter((m) => m.text.includes('定时备份首次成功：定时首成功'));

    // 手动跑一次：成功，但绝不能发「首次成功」通知，任务也不能被打标记
    await api('POST', `/api/tasks/${scTask.data.task.id}/run`);
    const scManualRun = await waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${scTask.data.task.id}`);
      const r = d.data.runs?.[0];
      return r && r.status !== 'running' ? r : null;
    }, 60000);
    ok(scManualRun.status === 'success' && scManualRun.trigger === 'manual',
      '前置：手动执行成功且记录带 manual 来源标记');
    await sleep(1200);
    ok(firstOkMsgs().length === 0, '手动成功不发「定时备份首次成功」通知');

    // 工具：停网关 → 改数据文件 → 重启并重新登录（与第 12 节同款手法）
    const restartGwWith = async (mutate) => {
      gw.kill('SIGTERM');
      await sleep(1200);
      gw.kill('SIGKILL');
      const dataFile = path.join(T, 'data', 'rclona.json');
      const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      mutate(saved);
      fs.writeFileSync(dataFile, JSON.stringify(saved, null, 2));
      cookie = '';
      gw = spawnGw();
      await waitFor(async () => (await api('GET', '/api/auth/me')).status === 200, 20000);
      await api('POST', '/api/auth/login', { user: 'tester', password: 'testpass123' });
    };
    const pastIso = () => new Date(Date.now() - 60000).toISOString();

    // 把两个任务的 nextRunAt 拨到过去 → 重启后调度器会以 schedule 来源触发它们
    await restartGwWith((saved) => {
      for (const t of saved.tasks) {
        if (t.id === scTask.data.task.id || t.id === scBad.data.task.id) t.nextRunAt = pastIso();
      }
    });
    const scSchedRun = await waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${scTask.data.task.id}`);
      const r = (d.data.runs || []).find((x) => x.trigger === 'schedule');
      return r && r.status !== 'running' ? r : null;
    }, 90000);
    ok(scSchedRun.status === 'success', '定时触发的运行成功且记录带 schedule 来源标记',
      `状态=${scSchedRun.status}`);
    const tgFirst = await waitFor(async () => firstOkMsgs()[0] || null, 15000).catch(() => null);
    ok(!!tgFirst, '定时首次成功已通过 Telegram 发出');
    ok(tgFirst && tgFirst.text.includes('tsrc → tdst') && tgFirst.text.includes('本次传输')
      && tgFirst.text.includes('计划：每天 04:00')
      && tgFirst.text.includes(`http://panel.example.com:8080/runs?focus=${scSchedRun.id}`),
      '首次成功通知内容齐全（网盘方向/传输统计/人话计划/记录链接）',
      tgFirst ? tgFirst.text.split('\n').slice(0, 4).join(' | ') : '未收到');
    const scBadRun = await waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${scBad.data.task.id}`);
      const r = (d.data.runs || []).find((x) => x.trigger === 'schedule');
      return r && r.status !== 'running' ? r : null;
    }, 90000);
    ok(scBadRun.status === 'failed', '定时触发的坏任务按预期失败');
    const tgBad = await waitFor(async () => tgHas('备份失败', '定时坏任务') || null, 15000).catch(() => null);
    ok(!!tgBad, '定时失败仍按旧规则发失败通知（规则未被 #24 影响）');
    const scTaskNow = (await api('GET', '/api/tasks')).data.tasks.find((t) => t.id === scTask.data.task.id);
    ok(scTaskNow?.firstSuccessNotified === true, '任务已持久打上 firstSuccessNotified 标记');

    // 再拨一次到点：第二次定时成功不应再发首次成功通知
    await restartGwWith((saved) => {
      for (const t of saved.tasks) if (t.id === scTask.data.task.id) t.nextRunAt = pastIso();
    });
    const scSchedRun2 = await waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${scTask.data.task.id}`);
      const r = (d.data.runs || []).find((x) => x.trigger === 'schedule' && x.id !== scSchedRun.id);
      return r && r.status !== 'running' ? r : null;
    }, 90000);
    ok(scSchedRun2.status === 'success', '第二次定时运行同样成功');
    await sleep(2000);
    ok(firstOkMsgs().length === 1, '第二次定时成功不再发首次成功通知（总共仍只有 1 条）',
      `实际 ${firstOkMsgs().length} 条`);

    console.log('== 18. #23：个人资料里的改密接口（当前密码校验 + 新密码登录）==');
    const wrongPw = await api('POST', '/api/auth/password', {
      oldPassword: 'not-the-password', newPassword: 'newpass456'
    });
    ok(wrongPw.status === 400 && /当前密码不对/.test(wrongPw.data?.error || ''),
      '当前密码填错时拒绝改密', wrongPw.data?.error || '');
    const shortPw = await api('POST', '/api/auth/password', {
      oldPassword: 'testpass123', newPassword: 'short'
    });
    ok(shortPw.status === 400 && /至少 8 位/.test(shortPw.data?.error || ''),
      '新密码不足 8 位时拒绝改密', shortPw.data?.error || '');
    const changedPw = await api('POST', '/api/auth/password', {
      oldPassword: 'testpass123', newPassword: 'newpass456'
    });
    ok(changedPw.status === 200, '当前密码正确时改密成功');
    const meAfterPw = await api('GET', '/api/auth/me');
    ok(meAfterPw.data?.authed === true, '改密后当前会话仍有效（沿用现有进程内会话行为）');
    const logoutRes = await api('POST', '/api/auth/logout');
    ok(logoutRes.status === 200, '退出登录成功');
    const oldLogin = await api('POST', '/api/auth/login', { user: 'tester', password: 'testpass123' });
    ok(oldLogin.status === 401, '改密后旧密码不能再登录');
    const newLogin = await api('POST', '/api/auth/login', { user: 'tester', password: 'newpass456' });
    ok(newLogin.status === 200, '改密后新密码可以登录');

    console.log('== 19. #26：每组映射的文件筛选（翻译 + 真实同步 + 与空占位共存）==');
    // 19a 翻译层：结构化规则 -> rclone FilterRule 的关键形态
    const folderExcludeRules = pairFilterRules([
      { action: 'exclude', target: 'folder', match: 'contains', value: 'cache' }
    ]);
    ok(folderExcludeRules.includes('- *cache*/**') && folderExcludeRules.includes('- **/*cache*/**')
      && !folderExcludeRules.includes('- **'),
      '翻译：排除「文件夹名字包含 cache」会覆盖根层与深层目录、且不误加全排除兜底',
      folderExcludeRules.join(' | '));
    ok(JSON.stringify(pairFilterRules([
      { action: 'include', target: 'file', match: 'ext', value: '.zip' }
    ])) === JSON.stringify(['+ *.zip', '- **']),
      '翻译：仅同步「文件扩展名 .zip」生成 include 规则并补 - ** 兜底');
    const fileExactRules = pairFilterRules([
      { action: 'include', target: 'file', match: 'exact', value: 'report' }
    ]);
    ok(fileExactRules.includes('+ report') && !fileExactRules.some((r) => r.includes('report/**')),
      '翻译：仅同步「文件名字等于 report」不会放行同名文件夹的内容');

    // 19b 校验：筛选内容为空时整单拒绝（中文提示）
    const badFilterTask = await api('POST', '/api/tasks', {
      name: '空筛选', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: srcDir, dst: dstDir, filters: [{ action: 'exclude', target: 'file', match: 'contains', value: '' }] }],
      schedule: { type: 'daily', time: '04:00' }
    });
    ok(badFilterTask.status !== 200 && /筛选.*不能为空/.test(badFilterTask.data?.error || ''),
      '筛选内容为空被拒绝（中文提示）', badFilterTask.data?.error || '');

    // 19c 造源：一棵同时含缓存文件夹、同名文件/文件夹、多种扩展名的树
    const fltSrc = path.join(T, 'filter', 'data');
    const mkFile = (rel, text) => {
      const p = path.join(fltSrc, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    };
    mkFile('cache-data/secret.txt', 'cache secret');
    mkFile('nested/cache-tmp/inner.zip', 'nested cache zip');
    mkFile('cache-notes.txt', 'file name contains cache');
    mkFile('keep/data.zip', 'keep zip');
    mkFile('backup.zip', 'root zip');
    mkFile('keep/notes.txt', 'keep notes');
    mkFile('keep/photo.jpg', 'keep photo');
    mkFile('named-file/report', 'the report file');
    mkFile('named-folder/report/inside.txt', 'inside report folder');
    const runFilterTask = async (name, filters, dst, src = fltSrc, remote = 'tsrc') => {
      const made = await api('POST', '/api/tasks', {
        name, srcRemote: remote, dstRemote: 'tdst',
        pairs: [{ src, dst, filters }],
        schedule: { type: 'daily', time: '04:00' }
      });
      if (made.status !== 200) throw new Error(`筛选任务创建失败：${JSON.stringify(made.data)}`);
      await api('POST', `/api/tasks/${made.data.task.id}/run`);
      return waitFor(async () => {
        const d = await api('GET', `/api/runs?taskId=${made.data.task.id}`);
        const r = d.data.runs?.[0];
        return r && r.status !== 'running' ? r : null;
      }, 60000);
    };

    // 排除文件夹（名字包含 cache）：文件夹没了，同名文件不受影响
    const fltDst1 = path.join(T, 'filterbak', 'exclude-folder');
    const fltRun1 = await runFilterTask('筛选-排除缓存文件夹', [
      { action: 'exclude', target: 'folder', match: 'contains', value: 'cache' }
    ], fltDst1);
    ok(fltRun1.status === 'success', '排除文件夹的任务运行成功', `状态=${fltRun1.status} ${fltRun1.reasonZh || ''}`);
    ok(!fs.existsSync(path.join(fltDst1, 'cache-data')) && !fs.existsSync(path.join(fltDst1, 'nested', 'cache-tmp')),
      '名字包含 cache 的文件夹（根层与深层）都没有同步过去');
    ok(fs.readFileSync(path.join(fltDst1, 'cache-notes.txt'), 'utf8') === 'file name contains cache'
      && fs.readFileSync(path.join(fltDst1, 'keep', 'notes.txt'), 'utf8') === 'keep notes',
      '文件夹规则没有误伤同名文件，其它文件正常同步');

    // 仅同步文件扩展名 .zip：只有 zip 到位
    const fltDst2 = path.join(T, 'filterbak', 'only-zip');
    const fltRun2 = await runFilterTask('筛选-只要zip', [
      { action: 'include', target: 'file', match: 'ext', value: '.zip' }
    ], fltDst2);
    ok(fltRun2.status === 'success', '仅同步扩展名的任务运行成功', `状态=${fltRun2.status} ${fltRun2.reasonZh || ''}`);
    ok(fs.readFileSync(path.join(fltDst2, 'backup.zip'), 'utf8') === 'root zip'
      && fs.readFileSync(path.join(fltDst2, 'keep', 'data.zip'), 'utf8') === 'keep zip'
      && fs.readFileSync(path.join(fltDst2, 'nested', 'cache-tmp', 'inner.zip'), 'utf8') === 'nested cache zip',
      '根层与子目录里的 .zip 文件都同步到位');
    ok(!fs.existsSync(path.join(fltDst2, 'keep', 'notes.txt')) && !fs.existsSync(path.join(fltDst2, 'keep', 'photo.jpg'))
      && !fs.existsSync(path.join(fltDst2, 'cache-notes.txt')),
      '非 .zip 文件没有同步过去');

    // 仅同步「文件」名字等于 report：文件到位，同名文件夹的内容不来
    const fltDst3 = path.join(T, 'filterbak', 'only-report-file');
    const fltRun3 = await runFilterTask('筛选-只要report文件', [
      { action: 'include', target: 'file', match: 'exact', value: 'report' }
    ], fltDst3);
    ok(fltRun3.status === 'success', '仅同步同名文件的任务运行成功', `状态=${fltRun3.status} ${fltRun3.reasonZh || ''}`);
    ok(fs.readFileSync(path.join(fltDst3, 'named-file', 'report'), 'utf8') === 'the report file',
      '名为 report 的文件同步到位');
    ok(!fs.existsSync(path.join(fltDst3, 'named-folder', 'report', 'inside.txt')),
      '名为 report 的文件夹内容没有被文件规则误放行');

    // 19d 与 #18 共存：重新把占位 fixture 灌回 memory 网盘（第 17 节重启过网关，内存内容已清空），
    // 用户规则（排除文件 other.txt）与空占位自动跳过同时生效
    await rcdCall('sync/copy', { srcFs: stC, dstFs: 'tmem:appdata/legado' });
    await rcdCall('sync/copy', { srcFs: stA, dstFs: 'tmem:' });
    await rcdCall('sync/copy', { srcFs: stB, dstFs: 'tmem:' });
    const phDst2 = path.join(T, 'phbak-filter');
    const fltRun4 = await runFilterTask('筛选与空占位共存', [
      { action: 'exclude', target: 'file', match: 'exact', value: 'other.txt' }
    ], phDst2, '', 'tmem');
    ok(fltRun4.status === 'success', '带用户筛选时含空占位的任务仍运行成功',
      `状态=${fltRun4.status} ${fltRun4.reasonZh || ''}`);
    ok(fs.readFileSync(path.join(phDst2, 'appdata', 'legado', 'inner.txt'), 'utf8') === 'realdata',
      '空占位同名目录里的真文件仍同步到位（自动跳过未被用户规则覆盖）');
    ok(!fs.existsSync(path.join(phDst2, 'appdata', 'other.txt')),
      '用户筛选规则同时生效（other.txt 被排除）');
    ok(/已自动跳过 2 个空占位对象/.test(fltRun4.logExcerpt || ''),
      '日志仍注明自动跳过的空占位数量');

    console.log('== 20. #27 A 段：旧版本保留 / 删除安全阀 / 试运行 / 变更明细 / 限速 / 改名 ==');
    const today27 = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const mkTask27 = async (body) => {
      const made = await api('POST', '/api/tasks', body);
      if (made.status !== 200) throw new Error(`#27 任务创建失败：${JSON.stringify(made.data)}`);
      return made.data.task;
    };
    const waitRun27 = async (taskId, seenIds, timeout = 90000) => waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${taskId}`);
      const r = (d.data.runs || []).find((x) => !seenIds.has(x.id) && x.status !== 'running');
      return r || null;
    }, timeout);
    const runNew27 = async (task) => {
      const seen = new Set(((await api('GET', `/api/runs?taskId=${task.id}`)).data.runs || []).map((r) => r.id));
      await api('POST', `/api/tasks/${task.id}/run`);
      return waitRun27(task.id, seen);
    };

    // ① 旧版本保留：被覆盖/删除的文件进归档、过期归档被清、归档区不被镜像删
    const vSrc = path.join(T, 'v27', 'src'); const vDst = path.join(T, 'v27', 'dst');
    fs.mkdirSync(vSrc, { recursive: true });
    fs.mkdirSync(path.join(vDst, '.rclona-archive', '2000-01-01'), { recursive: true });
    fs.writeFileSync(path.join(vSrc, 'f.txt'), 'v1');
    fs.writeFileSync(path.join(vSrc, 'del.txt'), 'to be deleted');
    fs.writeFileSync(path.join(vDst, '.rclona-archive', '2000-01-01', 'old.txt'), 'ancient');
    const verTask = await mkTask27({
      name: '版本保留任务', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: vSrc, dst: vDst }],
      schedule: { type: 'daily', time: '04:00' },
      versioning: { enabled: true, keepDays: 30 }
    });
    const verRun1 = await runNew27(verTask);
    ok(verRun1.status === 'success', '版本保留任务第一次运行成功', `状态=${verRun1.status} ${verRun1.reasonZh || ''}`);
    fs.writeFileSync(path.join(vSrc, 'f.txt'), 'v2');
    fs.rmSync(path.join(vSrc, 'del.txt'));
    fs.writeFileSync(path.join(vSrc, 'add.txt'), 'brand new');
    const verRun2 = await runNew27(verTask);
    ok(verRun2.status === 'success', '版本保留任务第二次运行成功', `状态=${verRun2.status} ${verRun2.reasonZh || ''}`);
    const archDir = path.join(vDst, '.rclona-archive', today27);
    ok(fs.existsSync(path.join(archDir, 'f.txt')) && fs.readFileSync(path.join(archDir, 'f.txt'), 'utf8') === 'v1',
      '被覆盖的旧版 f.txt 已进当天归档（内容是旧版 v1）');
    ok(fs.existsSync(path.join(archDir, 'del.txt')) && fs.readFileSync(path.join(archDir, 'del.txt'), 'utf8') === 'to be deleted',
      '被删除的 del.txt 已进当天归档');
    ok(!fs.existsSync(path.join(vDst, '.rclona-archive', '2000-01-01')), '超过保留天数的旧归档目录已被清理');
    ok(fs.readFileSync(path.join(vDst, 'f.txt'), 'utf8') === 'v2' && !fs.existsSync(path.join(vDst, 'del.txt'))
      && fs.readFileSync(path.join(vDst, 'add.txt'), 'utf8') === 'brand new', '目标本体仍是纯镜像结果（新版到位、删除生效、新文件到位）');
    ok(/归档区/.test(verRun2.logExcerpt || ''), '运行日志注明了本次归档');
    // 变更明细（第 4 项）与版本保留同跑验证：三类各一例、计数与截断标记对
    const vc = verRun2.changes || {};
    ok(vc.counts?.added === 1 && vc.counts?.updated === 1 && vc.counts?.deleted === 1 && vc.truncated === false,
      '变更明细计数正确（新增 1 / 更新 1 / 删除 1，未截断）', JSON.stringify(vc.counts || {}));
    ok((vc.added || []).includes('add.txt') && (vc.updated || []).includes('f.txt') && (vc.deleted || []).includes('del.txt'),
      '变更明细三类清单各含预期文件');
    const verRun3 = await runNew27(verTask);
    ok(verRun3.status === 'success' && fs.existsSync(archDir),
      '无变化再跑一次：归档区不被镜像同步删掉', `状态=${verRun3.status}`);
    ok((verRun3.changes?.counts?.added ?? -1) === 0 && (verRun3.changes?.counts?.deleted ?? -1) === 0,
      '无变化运行的变更明细计数为 0');

    // ② 删除安全阀（个数上限）：超限中止、一个不删、失败原因与 Telegram 都点名安全阀
    const gSrc = path.join(T, 'g27', 'src'); const gDst = path.join(T, 'g27', 'dst');
    fs.mkdirSync(gSrc, { recursive: true }); fs.mkdirSync(gDst, { recursive: true });
    fs.writeFileSync(path.join(gSrc, 'keep.txt'), 'same');
    fs.writeFileSync(path.join(gDst, 'keep.txt'), 'same');
    for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(gDst, `stale${i}.txt`), `stale ${i}`);
    const guardTask = await mkTask27({
      name: '安全阀任务', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: gSrc, dst: gDst }],
      schedule: { type: 'daily', time: '04:00' },
      maxDelete: { count: 2, percent: 0 }
    });
    const guardRun = await runNew27(guardTask);
    ok(guardRun.status === 'failed' && guardRun.failedStage === 3, '安全阀触发：任务在传输阶段标失败',
      `状态=${guardRun.status} 阶段=${guardRun.failedStage}`);
    ok(/安全阀/.test(guardRun.reasonZh || '') && /4 个文件/.test(guardRun.reasonZh || ''),
      '失败原因点名删除安全阀并写清将删数量', guardRun.reasonZh || '');
    ok([1, 2, 3, 4].every((i) => fs.existsSync(path.join(gDst, `stale${i}.txt`))),
      '安全阀拦下后目标文件一个都没删');
    const tgGuard = await waitFor(async () => tgHas('备份失败', '安全阀') || null, 10000).catch(() => null);
    ok(!!tgGuard, '安全阀失败已发 Telegram 通知且文案点明安全阀');
    // 关掉安全阀再跑：删除正常生效（证明拦的是阀、不是任务本身坏了）
    const guardTaskNow = (await api('GET', '/api/tasks')).data.tasks.find((t) => t.id === guardTask.id);
    const putOff = await api('PUT', `/api/tasks/${guardTask.id}`, { ...guardTaskNow, maxDelete: { count: 0, percent: 0 } });
    ok(putOff.status === 200, '安全阀可经编辑关闭（0 = 不限）');
    const guardRun2 = await runNew27(guardTask);
    ok(guardRun2.status === 'success' && ![1, 2, 3, 4].some((i) => fs.existsSync(path.join(gDst, `stale${i}.txt`))),
      '关闭安全阀后重跑成功，多余文件被正常删除');

    // ③ 删除安全阀（比例上限）：目标 10 个文件、源只剩 1 个，将删 9 个 > 30% 上限 3 个
    const pSrc = path.join(T, 'p27', 'src'); const pDst = path.join(T, 'p27', 'dst');
    fs.mkdirSync(pSrc, { recursive: true }); fs.mkdirSync(pDst, { recursive: true });
    fs.writeFileSync(path.join(pSrc, 'common.txt'), 'c');
    fs.writeFileSync(path.join(pDst, 'common.txt'), 'c');
    for (let i = 1; i <= 9; i++) fs.writeFileSync(path.join(pDst, `old${i}.txt`), `old ${i}`);
    const pctTask = await mkTask27({
      name: '安全阀比例任务', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: pSrc, dst: pDst }],
      schedule: { type: 'daily', time: '04:00' },
      maxDelete: { count: 0, percent: 30 }
    });
    const pctRun = await runNew27(pctTask);
    ok(pctRun.status === 'failed' && /安全阀/.test(pctRun.reasonZh || ''), '比例安全阀同样拦下（将删 9 个 > 上限 3 个）',
      pctRun.reasonZh || '');
    ok([1, 2, 3, 4, 5, 6, 7, 8, 9].every((i) => fs.existsSync(path.join(pDst, `old${i}.txt`))),
      '比例安全阀拦下后目标文件完好');

    // ④ 试运行预览：清单与计数对、目标分毫未动、不落记录不发通知
    const pvSrc = path.join(T, 'pv27', 'src'); const pvDst = path.join(T, 'pv27', 'dst');
    fs.mkdirSync(pvSrc, { recursive: true }); fs.mkdirSync(pvDst, { recursive: true });
    fs.writeFileSync(path.join(pvSrc, 'new1.txt'), 'new');
    fs.writeFileSync(path.join(pvSrc, 'mod.txt'), 'v2');
    fs.writeFileSync(path.join(pvSrc, 'same.txt'), 'x');
    fs.writeFileSync(path.join(pvDst, 'mod.txt'), 'v1');
    fs.writeFileSync(path.join(pvDst, 'same.txt'), 'x');
    fs.writeFileSync(path.join(pvDst, 'stale.txt'), 'stale');
    const pvTask = await mkTask27({
      name: '试运行任务', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: pvSrc, dst: pvDst }],
      schedule: { type: 'daily', time: '04:00' }
    });
    const tgBeforePv = tgMessages.length;
    const pv = await api('POST', `/api/tasks/${pvTask.id}/preview`);
    const pvPair = pv.data?.preview?.pairs?.[0] || {};
    ok(pv.status === 200 && !pvPair.error, '试运行接口成功返回', pvPair.error || '');
    ok((pvPair.added || []).includes('new1.txt') && (pvPair.updated || []).includes('mod.txt') && (pvPair.deleted || []).includes('stale.txt'),
      '试运行清单三类各含预期文件');
    ok(pvPair.counts?.added === 1 && pvPair.counts?.updated === 1 && pvPair.counts?.deleted === 1,
      '试运行计数正确（新增 1 / 更新 1 / 删除 1）', JSON.stringify(pvPair.counts || {}));
    ok(pvPair.dryRun?.transfers === 2 && pvPair.dryRun?.deletes === 1,
      '试运行 dry-run 交叉计数一致（传输 2 / 删除 1）', JSON.stringify(pvPair.dryRun || {}));
    ok(fs.readFileSync(path.join(pvDst, 'mod.txt'), 'utf8') === 'v1' && !fs.existsSync(path.join(pvDst, 'new1.txt'))
      && fs.existsSync(path.join(pvDst, 'stale.txt')), '试运行没有动目标的任何文件');
    const pvRuns = await api('GET', `/api/runs?taskId=${pvTask.id}`);
    ok((pvRuns.data.runs || []).length === 0, '试运行不落运行记录');
    ok(tgMessages.length === tgBeforePv, '试运行不发任何通知');

    // ⑤ 限速：2MB 文件限 200k 应明显变慢；不限速任务随后恢复正常速度（证明全局开关已还原）
    const bSrc = path.join(T, 'bw27', 'src');
    fs.mkdirSync(bSrc, { recursive: true });
    fs.writeFileSync(path.join(bSrc, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 5));
    const bwTask = await mkTask27({
      name: '限速任务', srcRemote: 'tsrc', dstRemote: 'tmem',
      pairs: [{ src: bSrc, dst: 'bwtest' }],
      schedule: { type: 'daily', time: '04:00' },
      bwlimit: '200k'
    });
    const bwRun = await runNew27(bwTask);
    const bwMs = new Date(bwRun.finishedAt) - new Date(bwRun.startedAt);
    ok(bwRun.status === 'success', '限速任务运行成功', `状态=${bwRun.status} ${bwRun.reasonZh || ''}`);
    ok(bwMs >= 5000, `限速真生效：2MB 文件限速 200k 耗时 ${Math.round(bwMs / 1000)} 秒（不限速时约 2 秒）`);
    const bwFreeTask = await mkTask27({
      name: '不限速任务', srcRemote: 'tsrc', dstRemote: 'tmem',
      pairs: [{ src: bSrc, dst: 'bwtest2' }],
      schedule: { type: 'daily', time: '04:00' }
    });
    const bwFreeRun = await runNew27(bwFreeTask);
    const bwFreeMs = new Date(bwFreeRun.finishedAt) - new Date(bwFreeRun.startedAt);
    ok(bwFreeRun.status === 'success' && bwFreeMs < bwMs - 3000,
      `限速已还原：紧接着的不限速任务耗时 ${Math.round(bwFreeMs / 1000)} 秒`, `状态=${bwFreeRun.status}`);
    const bwList = await rcdCall('operations/list', { fs: 'tmem:bwtest', remote: '', opt: { recurse: true } });
    ok((bwList.list || []).some((e) => e.Path === 'big.bin' && e.Size === 2 * 1024 * 1024),
      '限速任务的文件完整到达内存网盘');

    // ⑥ 改名不重传：源改名后重跑，传输计数为 0、改名计数为 1、目标完成改名
    const rnSrc = path.join(T, 'rn27', 'src'); const rnDst = path.join(T, 'rn27', 'dst');
    fs.mkdirSync(rnSrc, { recursive: true }); fs.mkdirSync(rnDst, { recursive: true });
    fs.writeFileSync(path.join(rnSrc, 'orig.txt'), 'rename me');
    const rnTask = await mkTask27({
      name: '改名任务', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: rnSrc, dst: rnDst }],
      schedule: { type: 'daily', time: '04:00' },
      trackRenames: true
    });
    const rnRun1 = await runNew27(rnTask);
    ok(rnRun1.status === 'success', '改名任务第一次运行成功', `状态=${rnRun1.status}`);
    fs.renameSync(path.join(rnSrc, 'orig.txt'), path.join(rnSrc, 'renamed.txt'));
    const rnRun2 = await runNew27(rnTask);
    ok(rnRun2.status === 'success', '改名任务第二次运行成功', `状态=${rnRun2.status} ${rnRun2.reasonZh || ''}`);
    ok(rnRun2.stats?.transferred === 0 && rnRun2.stats?.renames === 1,
      '改名没有重传：传输计数 0、改名计数 1', JSON.stringify(rnRun2.stats || {}));
    ok(fs.readFileSync(path.join(rnDst, 'renamed.txt'), 'utf8') === 'rename me' && !fs.existsSync(path.join(rnDst, 'orig.txt')),
      '目标里文件已改名且内容一致');

    // ⑦ 参数校验：坏限速、越界比例在建任务时就被拦下
    const badBw = await api('POST', '/api/tasks', {
      name: '坏限速', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: pvSrc, dst: pvDst }], schedule: { type: 'daily', time: '04:00' }, bwlimit: 'abc!'
    });
    ok(badBw.status !== 200 && /限速/.test(badBw.data?.error || ''), '限速格式不对时建任务被拒并给出人话原因',
      badBw.data?.error || `status=${badBw.status}`);
    const badPct = await api('POST', '/api/tasks', {
      name: '坏比例', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: pvSrc, dst: pvDst }], schedule: { type: 'daily', time: '04:00' }, maxDelete: { count: 0, percent: 101 }
    });
    ok(badPct.status !== 200 && /安全阀|比例/.test(badPct.data?.error || ''), '安全阀比例越界时建任务被拒',
      badPct.data?.error || `status=${badPct.status}`);

    console.log('== 21. #27 B 段：面板取回文件 / 备份加密 / 容量提醒 / 任务复制与配置导出导入 ==');
    const dataDir21 = path.join(T, 'data');
    const storeText21 = () => fs.readFileSync(path.join(dataDir21, 'rclona.json'), 'utf8');
    const rcloneCli = (args) => new Promise((resolve, reject) => {
      const p = spawn(RCLONE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = []; let err = '';
      p.stdout.on('data', (d) => chunks.push(d));
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`rclone CLI 失败(${code})：${err.slice(-300)}`))));
    });

    // 21a 文件浏览与流式下载：目录+文件一起列、文件能下、文件夹被拦、未登录被拒
    const dlSrc = path.join(T, 'dl21', 'files');
    fs.mkdirSync(path.join(dlSrc, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(dlSrc, 'note.txt'), 'download me please');
    fs.writeFileSync(path.join(dlSrc, 'inner', 'deep.txt'), 'deep content');
    const bigBuf = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < bigBuf.length; i++) bigBuf[i] = i % 251;
    fs.writeFileSync(path.join(dlSrc, 'big.bin'), bigBuf);
    const filesRes = await api('GET', `/api/files?remote=tsrc&path=${encodeURIComponent(dlSrc)}`);
    const fNote = (filesRes.data?.files || []).find((f) => f.name === 'note.txt');
    ok(filesRes.status === 200 && !!fNote && fNote.size === 18
      && (filesRes.data.dirs || []).some((d) => d.name === 'inner'),
      '文件浏览同时列出文件（带大小）与子目录');
    const dlFetch = (p) => fetch(BASE + p, { headers: { Cookie: cookie } });
    const dl1 = await dlFetch(`/api/download?remote=tsrc&path=${encodeURIComponent(path.join(dlSrc, 'note.txt'))}`);
    ok(dl1.status === 200 && (await dl1.text()) === 'download me please', '小文件下载内容一致');
    ok((dl1.headers.get('content-disposition') || '').includes('note.txt'), '下载响应带正确的文件名头');
    const dlBig = await dlFetch(`/api/download?remote=tsrc&path=${encodeURIComponent(path.join(dlSrc, 'big.bin'))}`);
    const bigGot = Buffer.from(await dlBig.arrayBuffer());
    ok(dlBig.status === 200 && bigGot.equals(bigBuf), '3MB 大文件流式下载内容逐字节一致');
    const dlDir = await dlFetch(`/api/download?remote=tsrc&path=${encodeURIComponent(dlSrc)}`);
    const dlDirBody = await dlDir.json().catch(() => ({}));
    ok(dlDir.status === 400 && /文件夹/.test(dlDirBody.error || ''), '下载文件夹被拦下并给出中文提示', dlDirBody.error || `status=${dlDir.status}`);
    const dlAnon = await fetch(`${BASE}/api/download?remote=tsrc&path=${encodeURIComponent(path.join(dlSrc, 'note.txt'))}`);
    ok(dlAnon.status === 401, '未登录下载被拒（401）');

    // 21b 备份加密：没设密码时建任务被门禁拦下；设密码后真跑——落盘乱码、crypt 读回原文
    const crSrc = path.join(T, 'crypt21', 'src'); const crDst = path.join(T, 'crypt21', 'dst');
    fs.mkdirSync(path.join(crSrc, 'diary'), { recursive: true });
    fs.writeFileSync(path.join(crSrc, 'secret.txt'), 'top secret content');
    fs.writeFileSync(path.join(crSrc, 'diary', 'day1.txt'), 'dear diary');
    const gateRes = await api('POST', '/api/tasks', {
      name: '加密门禁', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: crSrc, dst: crDst }], schedule: { type: 'daily', time: '04:00' }, crypt: { enabled: true }
    });
    ok(gateRes.status !== 200 && /加密密码/.test(gateRes.data?.error || ''),
      '没设加密密码时，开启加密的任务保存被拦下并说明去哪设', gateRes.data?.error || `status=${gateRes.status}`);
    const CRYPT_PW = 'e2e-crypt-pw-21';
    const setPw = await api('PUT', '/api/settings', { backupCryptPassword: CRYPT_PW });
    ok(setPw.status === 200, '备份加密密码可经设置接口保存');
    const getSet21 = await api('GET', '/api/settings');
    ok(getSet21.data.cryptPasswordSet === true && !JSON.stringify(getSet21.data).includes(CRYPT_PW),
      '设置回读只报「已设置」、不含密码明文');
    ok(!storeText21().includes(CRYPT_PW), '本地记录文件里没有加密密码明文（只存混淆串）');
    const cryptTaskRes = await api('POST', '/api/tasks', {
      name: '加密备份', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: crSrc, dst: crDst }], schedule: { type: 'daily', time: '04:00' }, crypt: { enabled: true }
    });
    ok(cryptTaskRes.status === 200, '设好密码后加密任务可以创建');
    const cryptTaskId = cryptTaskRes.data.task.id;
    ok(!JSON.stringify((await api('GET', '/api/tasks')).data).includes(CRYPT_PW), '任务数据里不含加密密码（任务只存开关）');
    await api('POST', `/api/tasks/${cryptTaskId}/run`);
    const cryptRun = await waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${cryptTaskId}`);
      const r = d.data.runs?.[0];
      return r && r.status !== 'running' ? r : null;
    }, 60000);
    ok(cryptRun.status === 'success', '加密任务运行成功（五阶段全过，含校验）', `状态=${cryptRun.status} ${cryptRun.reasonZh || ''}`);
    const diskNames = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name)); else diskNames.push(e.name);
      }
    })(crDst);
    ok(diskNames.length === 2 && !diskNames.includes('secret.txt')
      && diskNames.every((n) => !n.includes('secret') && !n.includes('day1')),
      '目标磁盘上的文件名是加密乱码（找不到原文名）', diskNames.join(','));
    const rawFiles = await api('GET', `/api/files?remote=tdst&path=${encodeURIComponent(crDst)}`);
    ok((rawFiles.data?.files || []).length >= 1 && !(rawFiles.data.files || []).some((f) => f.name === 'secret.txt'),
      '面板直接浏览目标看到的也是乱码名（确实加密落盘）');
    const remotesAfterCrypt = await api('GET', '/api/remotes');
    ok(!(remotesAfterCrypt.data.remotes || []).some((r) => r.name.startsWith('rclonacrypt-')),
      '加密任务跑完后临时加密通道已拆除（不留在网盘列表里）');
    // 读回验证：手动建一个同密码的 crypt remote 指到 crDst，经 rcd 列表与 CLI cat 验原文
    const obscured21 = (await rcloneCli(['obscure', CRYPT_PW])).toString('utf8').trim();
    await rcdCall('config/create', {
      name: 'treadcrypt', type: 'crypt',
      parameters: { remote: `tdst:${crDst}`, filename_encryption: 'standard', directory_name_encryption: 'true', password: obscured21 }
    });
    const crList = await rcdCall('operations/list', { fs: 'treadcrypt:', remote: '', opt: { recurse: true } });
    const crPaths = (crList.list || []).filter((e) => !e.IsDir).map((e) => e.Path).sort();
    ok(JSON.stringify(crPaths) === JSON.stringify(['diary/day1.txt', 'secret.txt']),
      '经 crypt 读回的目录结构与原文件名一致', crPaths.join(','));
    const catOut = await rcloneCli(['cat', `--config=${path.join(dataDir21, 'rclone.conf')}`, 'treadcrypt:secret.txt']);
    ok(catOut.toString('utf8') === 'top secret content', '经 crypt 读回的文件内容与原文一致');
    await rcdCall('config/delete', { name: 'treadcrypt' });

    // 21c 容量提醒：阈值压到 1%，重启触发每日自检（连通+容量），应存下容量并只发一次提醒
    const capBad = await api('PUT', '/api/settings', { capacity: { alertPercent: 101 } });
    ok(capBad.status === 400 && /容量/.test(capBad.data?.error || ''), '容量阈值越界（101）被拒', capBad.data?.error || '');
    const capPut = await api('PUT', '/api/settings', { capacity: { alertPercent: 1 } });
    ok(capPut.status === 200, '容量阈值可保存（压到 1% 以便触发提醒）');
    // 本地网盘的容量 = 网关所在磁盘：这台机器磁盘只用了约 0.7%，够不到 1% 的整数阈值下限，
    // 提醒永远不会触发——临时写一个 3GB 填充文件把使用率顶过阈值，测完在 finally 里删掉。
    // 注意要写随机数据：写重复字节会被文件系统压缩/去重，物理占用涨不上去（实测踩过）。
    const fillPath = path.join(ROOT, '.e2e-capacity-fill.bin');
    const fillFd = fs.openSync(fillPath, 'w');
    for (let i = 0; i < 48; i++) fs.writeSync(fillFd, crypto.randomBytes(64 * 1024 * 1024));
    fs.closeSync(fillFd);
    try {
      gw.kill('SIGTERM');
      await sleep(1200);
      gw.kill('SIGKILL');
      env.HEALTH_DAILY_TIME = '00:00'; // 让重启后的第一个 tick 就跑每日自检
      cookie = '';
      gw = spawnGw();
      await waitFor(async () => (await api('GET', '/api/auth/me')).status === 200, 20000);
      // 注意：第 18 节已把面板密码改成 newpass456，重登录要用新密码
      const relogin21 = await api('POST', '/api/auth/login', { user: 'tester', password: 'newpass456' });
      ok(relogin21.status === 200, '容量段重启后可重新登录');
      const capRemote = await waitFor(async () => {
        const d = await api('GET', '/api/remotes');
        const r = (d.data.remotes || []).find((x) => x.name === 'tsrc');
        return r?.health?.about?.total > 0 ? r : null;
      }, 60000);
      ok(!!capRemote, '每日自检顺带存下了网盘容量（tsrc 总量可读）', JSON.stringify(capRemote?.health?.about || {}));
      ok(typeof capRemote.health.usedPercent === 'number' && capRemote.health.usedPercent >= 1,
        '容量使用率已算出且 ≥1%（与 1% 阈值同口径）', `usedPercent=${capRemote.health.usedPercent}`);
      const tgCap = await waitFor(async () => tgHas('网盘快满了', 'tsrc') || null, 20000).catch(() => null);
      ok(!!tgCap, '容量超阈值已发 Telegram 提醒');
      ok(capRemote.health.capacityAlerted === true, '提醒锁存已置位（同一轮超限不会重复轰炸）');
    } finally {
      fs.rmSync(fillPath, { force: true });
    }
    await api('PUT', '/api/settings', { capacity: { alertPercent: 90 } }); // 恢复默认，避免影响后续

    // 21d 任务复制：新 ID、名字带副本、先停用、配置一致、一键可编辑（返回完整任务）
    const dupSrc = await api('POST', '/api/tasks', {
      name: '复制源任务', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: srcDir, dst: dstDir }], schedule: { type: 'daily', time: '04:30' }
    });
    const dupRes = await api('POST', `/api/tasks/${dupSrc.data.task.id}/duplicate`);
    const dupTask = dupRes.data?.task;
    ok(dupRes.status === 200 && !!dupTask && dupTask.id !== dupSrc.data.task.id && /（副本）$/.test(dupTask.name),
      '任务复制生成新任务（新 ID、名字带「副本」）', dupTask?.name || '');
    ok(dupTask.enabled === false && dupTask.nextRunAt === null && dupTask.lastStatus === null,
      '副本先停用、无下次执行时间（不会自动跑）');
    ok(JSON.stringify(dupTask.pairs) === JSON.stringify(dupSrc.data.task.pairs), '副本的映射配置与原任务一致');

    // 21e 导出：带密码的网盘只记「哪些密码字段有值」，任何密钥明文都不得出现在文件里
    const davRes = await api('POST', '/api/remotes', {
      name: 'texportdav', type: 'webdav',
      config: { url: 'http://127.0.0.1:9/dav', user: 'u1', pass: 'dav-secret-pw-21' }
    });
    ok(davRes.status === 200, '带密码的 WebDAV 网盘创建成功（连不通不影响创建）');
    ok(!fs.readFileSync(path.join(dataDir21, 'rclone.conf'), 'utf8').includes('dav-secret-pw-21'),
      '前置：rclone 配置文件里存的也不是密码明文');
    const expRes = await fetch(`${BASE}/api/settings/export`, { headers: { Cookie: cookie } });
    const expText = await expRes.text();
    ok(expRes.status === 200 && (expRes.headers.get('content-disposition') || '').includes('rclona-config'),
      '导出接口返回配置文件下载');
    ok(!expText.includes('TESTTOKEN123') && !expText.includes('dav-secret-pw-21')
      && !expText.includes(CRYPT_PW) && !expText.includes('testpass123'),
      '导出文件不含任何密钥明文（Telegram 令牌/WebDAV 密码/加密密码/面板密码）');
    const expDoc = JSON.parse(expText);
    const expDav = (expDoc.remotes || []).find((r) => r.name === 'texportdav');
    ok(!!expDav && (expDav.secrets || []).includes('pass') && !('pass' in (expDav.config || {})) && expDav.config?.user === 'u1',
      '导出里 WebDAV 网盘只记「pass 已设置过」、不含其值，非敏感字段保留');
    ok((expDoc.tasks || []).some((t) => t.name === '复制源任务（副本）') && expDoc.settings?.telegram?.chatId === '424242',
      '导出含任务清单与非敏感设置');

    // 21f 导入往返：删掉副本任务与 texportdav 后导入应都回来（网盘带待补填标记、任务停用）；
    // 再导一次应全部同名跳过；坏文件/坏版本被拒
    await api('DELETE', `/api/tasks/${dupTask.id}`);
    await api('DELETE', '/api/remotes/texportdav');
    const imp1 = await api('POST', '/api/settings/import', { data: expDoc });
    const rep1 = imp1.data?.report || {};
    ok(imp1.status === 200 && rep1.remotesAdded?.includes('texportdav') && rep1.tasksAdded?.includes('复制源任务（副本）'),
      '导入把删掉的网盘与任务都加了回来', JSON.stringify(rep1));
    const remotesAfterImp = await api('GET', '/api/remotes');
    const davBack = (remotesAfterImp.data.remotes || []).find((r) => r.name === 'texportdav');
    ok(!!davBack && davBack.needsCredentials === true, '导入回来的网盘带「待补填凭证」标记');
    const tasksAfterImp = await api('GET', '/api/tasks');
    const dupBack = tasksAfterImp.data.tasks.find((t) => t.name === '复制源任务（副本）');
    ok(!!dupBack && dupBack.enabled === false && dupBack.id !== dupTask.id, '导入回来的任务是新 ID 且处于停用状态');
    const imp2 = await api('POST', '/api/settings/import', { data: expDoc });
    const rep2 = imp2.data?.report || {};
    ok((rep2.remotesAdded || []).length === 0 && (rep2.tasksAdded || []).length === 0
      && rep2.remotesSkipped?.includes('texportdav') && rep2.tasksSkipped?.includes('复制源任务（副本）'),
      '重复导入全部同名跳过（不覆盖、不产生重复）', JSON.stringify(rep2));
    const tasksFinal21 = await api('GET', '/api/tasks');
    ok(tasksFinal21.data.tasks.filter((t) => t.name === '复制源任务（副本）').length === 1,
      '重复导入后同名任务仍只有一个（无重复条目）');
    const impBad1 = await api('POST', '/api/settings/import', { data: { app: 'not-rclona', version: 1 } });
    ok(impBad1.status === 400 && /rclona/.test(impBad1.data?.error || ''), '非 rclona 文件被拒并给出中文原因', impBad1.data?.error || '');
    const impBad2 = await api('POST', '/api/settings/import', { data: { app: 'rclona', version: 99 } });
    ok(impBad2.status === 400 && /版本/.test(impBad2.data?.error || ''), '不支持的导出版本被拒', impBad2.data?.error || '');
    const impBad3 = await api('POST', '/api/settings/import', { data: '就是一个字符串' });
    ok(impBad3.status === 400, '结构不对的导入内容被拒');

    console.log('== 22. #30：同步模式（单向增加 / 双向同步 / 非法模式被拒）==');
    // 22a 非法同步方式在保存时被中文拦下
    const badMode = await api('POST', '/api/tasks', {
      name: '坏模式', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: srcDir, dst: dstDir }], schedule: { type: 'daily', time: '04:00' }, mode: 'sideways'
    });
    // 注：validateTask 的校验错误在本网关统一走 500 + 中文 error 文本（既有口径，如 cron 写错也是），前端照样能显示
    ok(badMode.status >= 400 && /同步方式/.test(badMode.data?.error || ''),
      '非法同步方式被拒并给出中文原因', badMode.data?.error || `status=${badMode.status}`);

    // 22b 单向增加（copy）：源删文件目标不删、源新增能过去、变更明细里没有「删除」
    const cpSrc = path.join(T, 'mode22', 'cp-src'); const cpDst = path.join(T, 'mode22', 'cp-dst');
    fs.mkdirSync(cpSrc, { recursive: true }); fs.mkdirSync(cpDst, { recursive: true });
    fs.writeFileSync(path.join(cpSrc, 'f1.txt'), 'copy one');
    fs.writeFileSync(path.join(cpSrc, 'keep.txt'), 'keep me');
    const cpTaskRes = await api('POST', '/api/tasks', {
      name: '单向增加任务', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: cpSrc, dst: cpDst }], schedule: { type: 'daily', time: '04:00' }, mode: 'copy'
    });
    ok(cpTaskRes.status === 200 && cpTaskRes.data.task.mode === 'copy', '单向增加任务创建成功且模式已保存');
    const cpTaskId = cpTaskRes.data.task.id;
    const waitRun = async (taskId, afterId) => waitFor(async () => {
      const d = await api('GET', `/api/runs?taskId=${taskId}`);
      const r = (d.data.runs || []).find((x) => x.id !== afterId);
      return r && r.status !== 'running' ? r : null;
    }, 90000);
    await api('POST', `/api/tasks/${cpTaskId}/run`);
    const cpRun1 = await waitRun(cpTaskId, '');
    ok(cpRun1.status === 'success', '单向增加首次执行成功', cpRun1.reasonZh || '');
    ok(fs.readFileSync(path.join(cpDst, 'keep.txt'), 'utf8') === 'keep me', '文件已复制到目标');
    fs.rmSync(path.join(cpSrc, 'keep.txt'));
    fs.writeFileSync(path.join(cpSrc, 'added.txt'), 'added later');
    await api('POST', `/api/tasks/${cpTaskId}/run`);
    const cpRun2 = await waitRun(cpTaskId, cpRun1.id);
    ok(cpRun2.status === 'success', '单向增加第二次执行成功', cpRun2.reasonZh || '');
    ok(fs.existsSync(path.join(cpDst, 'keep.txt')), '源已删除的文件在目标仍然保留（不删）');
    ok(fs.readFileSync(path.join(cpDst, 'added.txt'), 'utf8') === 'added later', '源新增的文件已传到目标');
    ok(cpRun2.changes && cpRun2.changes.counts.deleted === 0 && (cpRun2.changes.deleted || []).length === 0,
      '单向增加的变更明细里没有删除项', JSON.stringify(cpRun2.changes?.counts || {}));

    // 22c 双向同步（bisync）：首次对齐 → 两侧各改互相同步 → 同文件双改冲突留副本
    const bA = path.join(T, 'mode22', 'bi-a'); const bB = path.join(T, 'mode22', 'bi-b');
    fs.mkdirSync(bA, { recursive: true }); fs.mkdirSync(bB, { recursive: true });
    fs.writeFileSync(path.join(bA, 'a.txt'), 'from A');
    fs.writeFileSync(path.join(bB, 'b.txt'), 'from B');
    const biTaskRes = await api('POST', '/api/tasks', {
      name: '双向同步任务', srcRemote: 'tsrc', dstRemote: 'tdst',
      pairs: [{ src: bA, dst: bB }], schedule: { type: 'daily', time: '04:00' }, mode: 'bisync'
    });
    ok(biTaskRes.status === 200 && biTaskRes.data.task.mode === 'bisync', '双向同步任务创建成功且模式已保存');
    const biTaskId = biTaskRes.data.task.id;
    // 还没真跑过的双向任务，试运行要如实说「先真跑一次」
    const biPrev0 = await api('POST', `/api/tasks/${biTaskId}/preview`);
    ok(/先点「立即执行」|首次对齐/.test(biPrev0.data?.preview?.pairs?.[0]?.error || ''),
      '未对齐的双向任务试运行给出提示（先真跑一次）', biPrev0.data?.preview?.pairs?.[0]?.error || '');
    await api('POST', `/api/tasks/${biTaskId}/run`);
    const biRun1 = await waitRun(biTaskId, '');
    ok(biRun1.status === 'success', '双向同步首次执行（自动 resync 对齐）成功', biRun1.reasonZh || '');
    ok(fs.existsSync(path.join(bB, 'a.txt')) && fs.existsSync(path.join(bA, 'b.txt')),
      '首次对齐后两边文件齐了（A 的到了 B、B 的到了 A）');
    ok(!biRun1.changes, '双向同步不生成单向变更明细');
    fs.writeFileSync(path.join(bA, 'a2.txt'), 'A second');
    fs.writeFileSync(path.join(bB, 'b2.txt'), 'B second');
    fs.writeFileSync(path.join(bA, 'shared.txt'), 'shared v1');
    await api('POST', `/api/tasks/${biTaskId}/run`);
    const biRun2 = await waitRun(biTaskId, biRun1.id);
    ok(biRun2.status === 'success', '双向同步第二次执行成功', biRun2.reasonZh || '');
    ok(fs.existsSync(path.join(bB, 'a2.txt')) && fs.existsSync(path.join(bA, 'b2.txt'))
      && fs.readFileSync(path.join(bB, 'shared.txt'), 'utf8') === 'shared v1',
      '两侧各自的新文件都同步到了对方');
    const nowSec = Math.floor(Date.now() / 1000);
    const setM = (p, sec) => { const d = new Date(sec * 1000); fs.utimesSync(p, d, d); };
    fs.writeFileSync(path.join(bA, 'shared.txt'), 'A newer content');
    setM(path.join(bA, 'shared.txt'), nowSec);
    fs.writeFileSync(path.join(bB, 'shared.txt'), 'B older content');
    setM(path.join(bB, 'shared.txt'), nowSec - 3600);
    await api('POST', `/api/tasks/${biTaskId}/run`);
    const biRun3 = await waitRun(biTaskId, biRun2.id);
    ok(biRun3.status === 'success', '双向同步冲突轮执行成功', biRun3.reasonZh || '');
    ok(fs.readFileSync(path.join(bA, 'shared.txt'), 'utf8') === 'A newer content'
      && fs.readFileSync(path.join(bB, 'shared.txt'), 'utf8') === 'A newer content',
      '同文件双改：较新的版本胜出、两边一致');
    const conflictCopies = fs.readdirSync(bA).filter((n) => n.startsWith('shared.txt.conflict'));
    ok(conflictCopies.length >= 1 && fs.readFileSync(path.join(bA, conflictCopies[0]), 'utf8') === 'B older content',
      '较旧的版本被改名保留成冲突副本（没直接丢弃）', conflictCopies.join(','));

    // 22d 双向同步的删除安全：一次删太多（>一半）应被拦下且不传染
    const victims = ['a.txt', 'b.txt', 'a2.txt', 'b2.txt'];
    for (const v of victims) fs.rmSync(path.join(bB, v));
    await api('POST', `/api/tasks/${biTaskId}/run`);
    const biRun4 = await waitRun(biTaskId, biRun3.id);
    ok(biRun4.status === 'failed' && /删除的文件太多/.test(biRun4.reasonZh || ''),
      '双向同步一次删太多被安全机制拦下并给出人话原因', biRun4.reasonZh || '');
    ok(victims.every((v) => fs.existsSync(path.join(bA, v))),
      '被拦下后另一边的文件一个都没被删（防误删传染）');

    console.log(failures === 0 ? '\n全部自测通过 ✅' : `\n有 ${failures} 项未通过 ❌`);
  } finally {
    gw.kill('SIGTERM');
    await sleep(600);
    gw.kill('SIGKILL');
    tgSrv.close();
  }
  if (failures) { console.log('\n--- 网关日志（末尾）---\n' + gwLog.slice(-2500)); process.exit(1); }
}

main().catch((e) => { console.error('自测异常：', e); process.exit(1); });
