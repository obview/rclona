// rclona 网关端到端自测（无需真实网盘：本地目录 remote + 假 WebDAV 服务）
// 运行：npm run test:e2e（需要 RCLONE_BIN 指向 rclone 二进制，默认用仓库 .tools/rclone）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

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
    TICK_MS: '800'
  };
  const gw = spawn('node', ['src/index.js'], { cwd: path.join(ROOT, 'gateway'), env, stdio: 'pipe' });
  let gwLog = '';
  gw.stdout.on('data', (d) => { gwLog += d; });
  gw.stderr.on('data', (d) => { gwLog += d; });

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

    console.log('== 6. 网盘自检状态机（连败3次判失效 → 恢复自动解除）==');
    const DAVPORT = 18787;
    const bad = await api('POST', '/api/remotes', {
      name: 'tdav', type: 'webdav', config: { url: `http://127.0.0.1:${DAVPORT}/dav` }
    });
    ok(bad.status === 200 && bad.data.test?.ok === false, '假网盘创建（自动首测失败）');
    let davRemote = null;
    davRemote = await waitFor(async () => {
      const d = await api('GET', '/api/remotes');
      const r = d.data.remotes.find((x) => x.name === 'tdav');
      return r?.health?.status === 'down' ? r : null;
    }, 150000); // 每次失败检查约 16s（rclone 对 WebDAV 的内部重试），放宽等待
    ok(true, '复测节奏自动推进至「连接失效」（down）', `failCount=${davRemote.health.failCount} 原因=${davRemote.health.cause}`);
    const davSrv = await startFakeDav(DAVPORT);
    const recovered = await waitFor(async () => {
      const d = await api('GET', '/api/remotes');
      const r = d.data.remotes.find((x) => x.name === 'tdav');
      return r?.health?.status === 'ok' ? r : null;
    }, 90000);
    ok(!!recovered, '假 WebDAV 上线后无需人工干预自动恢复为连接正常');
    davSrv.close();

    console.log('== 7. 概览聚合接口 ==');
    const ov = await api('GET', '/api/overview');
    ok(ov.status === 200 && ov.data.remotes.length >= 3 && ov.data.tasks.length >= 3, '概览返回网盘/任务/记录聚合',
      `网盘 ${ov.data.remotes.length} 个，任务 ${ov.data.tasks.length} 个`);

    console.log(failures === 0 ? '\n全部自测通过 ✅' : `\n有 ${failures} 项未通过 ❌`);
  } finally {
    gw.kill('SIGTERM');
    await sleep(600);
    gw.kill('SIGKILL');
  }
  if (failures) { console.log('\n--- 网关日志（末尾）---\n' + gwLog.slice(-2500)); process.exit(1); }
}

main().catch((e) => { console.error('自测异常：', e); process.exit(1); });
