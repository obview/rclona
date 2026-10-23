// rclona 网关端到端自测（无需真实网盘：本地目录 remote + 假 WebDAV 服务）
// 运行：npm run test:e2e（需要 RCLONE_BIN 指向 rclone 二进制，默认用仓库 .tools/rclone）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { classifyError } from '../src/classify.js';

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
