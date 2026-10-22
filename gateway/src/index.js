import { cfg } from './config.js';
import { store } from './store.js';
import { startRcd, stopRcd } from './rc.js';
import { createServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { needsSetup } from './auth.js';

process.env.TZ = cfg.tz;

async function main() {
  store.load(cfg.dataDir);
  console.log(`[rclona] 数据目录：${cfg.dataDir}`);
  await startRcd();
  console.log('[rclona] rclone rcd 已就绪');
  const server = createServer();
  server.listen(cfg.port, () => {
    console.log(`[rclona] 面板已启动：http://0.0.0.0:${cfg.port}`);
    if (needsSetup()) console.log('[rclona] 尚未设置账号：打开面板会引导首次设置（或用 PANEL_USER/PANEL_PASSWORD 环境变量预置）');
  });
  startScheduler();
  const shutdown = () => { stopRcd(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error('[rclona] 启动失败：', e); process.exit(1); });
