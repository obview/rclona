import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 极简的 JSON 持久化：数据量很小（任务、记录、设置），整存整取 + 原子写
const FILE = 'rclona.json';

export function newId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

const DEFAULTS = () => ({
  auth: null, // {user, salt, hash} —— 首次启动由环境变量或设置向导生成
  settings: {
    notify: { enabled: false, to: '' },
    smtp: { host: '', port: 465, secure: true, user: '', pass: '' }
  },
  tasks: [],
  runs: [],
  health: {}, // remote 名 -> 自检状态
  healthMeta: { lastDailyDate: '' }
});

export const store = {
  data: DEFAULTS(),
  dir: '',
  load(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FILE);
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.data = { ...DEFAULTS(), ...parsed };
        this.data.settings = { ...DEFAULTS().settings, ...(parsed.settings || {}) };
      } catch (e) {
        console.error('[store] 记录文件损坏，已重置：', e.message);
        this.data = DEFAULTS();
      }
    }
  },
  save() {
    const file = path.join(this.dir, FILE);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, file);
  },
  addRun(run) {
    this.data.runs.unshift(run);
    if (this.data.runs.length > 500) this.data.runs.length = 500;
    this.save();
  },
  updateRun(id, patch) {
    const r = this.data.runs.find((x) => x.id === id);
    if (r) { Object.assign(r, patch); this.save(); }
    return r;
  }
};
