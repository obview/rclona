import { store } from './store.js';
import { rc, fsSpec, obscureValue } from './rc.js';

// #27 B 段：备份加密（rclone crypt 覆盖层）。
// 口径：
// - 加密密码是「全局一份」，由用户在设置页自填；只以 rclone obscure 后的串存进本地记录
//   （不明文落盘、任何接口都不回传），任务里只存一个开关，密码永不进任务/导出/日志。
// - 任务开启加密后，每组映射运行时临时构造一个 crypt remote（包住该组的目标位置），
//   同步/校验/比对全部走它：落到目标网盘的文件名、目录名、内容都是加密的；
//   这组跑完立刻删掉这个临时 remote，rclone.conf 里不长期留加密定义。
// - 加密参数：文件名与目录名都加密（standard），不加第二密码（salt）——少一个要记的东西，
//   丢了主密码照样全废，警告语已在 UI 写明。

export function cryptPasswordSet() {
  return !!(store.data.settings.backupCrypt?.password || '').trim();
}

// 设置/更换加密密码（明文只在内存里过手，入库前先 obscure）
export async function setCryptPassword(plain) {
  const p = String(plain || '');
  if (p.length < 4) throw new Error('备份加密密码至少 4 位（建议设一个你记得住、又没在别处用过的长密码）');
  const obscured = await obscureValue(p);
  if (!store.data.settings.backupCrypt) store.data.settings.backupCrypt = { password: '' };
  store.data.settings.backupCrypt.password = obscured;
  store.save();
}

export function clearCryptPassword() {
  if (!store.data.settings.backupCrypt) store.data.settings.backupCrypt = { password: '' };
  store.data.settings.backupCrypt.password = '';
  store.save();
}

// 临时 crypt remote 名：带任务 id 与组号，不同任务/组互不冲突，也不会撞上用户自己的网盘名
export function cryptRemoteName(taskId, pairIdx) {
  return `rclonacrypt-${String(taskId).replace(/[^A-Za-z0-9]+/g, '')}-${pairIdx}`;
}

// 为一组映射构造（或刷新）crypt remote，返回其名字；密码没设置时抛中文错误。
// 已存在同名 crypt（上次异常没删干净）就原地更新参数；存在同名但不是 crypt 的东西绝不动它。
export async function ensureCryptRemote(task, pair, pairIdx) {
  const obscured = (store.data.settings.backupCrypt?.password || '').trim();
  if (!obscured) {
    throw new Error('这个任务开启了备份加密，但备份加密密码还没有设置：请先到「设置」页填好密码（密码丢失 = 加密的备份全部无法恢复，务必记牢）');
  }
  const name = cryptRemoteName(task.id, pairIdx);
  const params = {
    remote: fsSpec(task.dstRemote, pair.dst),
    filename_encryption: 'standard',
    directory_name_encryption: 'true',
    password: obscured
  };
  let existing = null;
  try { existing = await rc.getRemote(name); } catch { /* 取不到按不存在处理 */ }
  if (existing && existing.type && existing.type !== 'crypt') {
    throw new Error(`内部加密通道名字被占用（${name}），为安全起见已停下`);
  }
  if (existing && existing.type === 'crypt') await rc.updateRemote(name, params);
  else await rc.createRemote(name, 'crypt', params);
  return name;
}

// 跑完拆除临时 crypt remote（失败无所谓：下次运行会原地刷新它）
export async function dropCryptRemote(name) {
  if (!name) return;
  try { await rc.deleteRemote(name); } catch { /* 拆不掉不影响备份结果 */ }
}
