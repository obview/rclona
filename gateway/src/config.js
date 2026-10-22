import path from 'node:path';

// 全部配置来自环境变量（见仓库根目录 .env.example）
export const cfg = {
  port: Number(process.env.PORT || 8080),
  dataDir: process.env.DATA_DIR || path.resolve(process.cwd(), 'data'),
  staticDir: process.env.STATIC_DIR || '',
  rcloneBin: process.env.RCLONE_BIN || 'rclone',
  rcAddr: process.env.RC_ADDR || '127.0.0.1:5572',
  tz: process.env.TZ || 'Asia/Shanghai',
  panelUser: process.env.PANEL_USER || '',
  panelPassword: process.env.PANEL_PASSWORD || '',
  // 网盘自检：每天几点跑（北京时间取决于 TZ）、失败复测间隔、连败几次判定失效
  healthDailyTime: process.env.HEALTH_DAILY_TIME || '03:00',
  healthRetryMs: Number(process.env.HEALTH_RETRY_MS || 5 * 60 * 1000),
  healthFailThreshold: Number(process.env.HEALTH_FAIL_THRESHOLD || 3),
  tickMs: Number(process.env.TICK_MS || 15000),
  runTimeoutMs: Number(process.env.RUN_TIMEOUT_MS || 6 * 60 * 60 * 1000)
};
