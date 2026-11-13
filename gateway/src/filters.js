// #26：把任务里结构化的文件筛选规则翻译成 rclone 的 FilterRule。
// 规则顺序就是用户填写的顺序，rclone 按从上到下「第一次命中即定」处理；
// 只要存在任意一条「仅同步（include）」规则，末尾就补一条 - **，实现只同步命中项。

const ACTIONS = new Set(['include', 'exclude']);
const TARGETS = new Set(['file', 'folder', 'any']);
const MATCHES = new Set(['contains', 'exact', 'ext', 'glob', 'path']);

export function escapeFilterLiteral(value) {
  return String(value).replace(/([\\*?\[\]{}])/g, '\\$1');
}

export function extensionOf(value) {
  return String(value || '').trim().replace(/^\.+/, '');
}

export function normalizePairFilters(rawFilters, pairIndex = 0) {
  if (rawFilters == null) return [];
  const where = pairIndex ? `第 ${pairIndex} 组` : '筛选';
  if (!Array.isArray(rawFilters)) throw new Error(`${where}的文件筛选格式不对`);
  return rawFilters.map((raw, i) => {
    const nth = `${where}第 ${i + 1} 条筛选`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${nth}格式不对`);
    const action = String(raw.action || '');
    const target = String(raw.target || '');
    const match = String(raw.match || '');
    let value = String(raw.value ?? '').trim();
    if (!ACTIONS.has(action)) throw new Error(`${nth}的作用只能是「仅同步」或「排除」`);
    if (!TARGETS.has(target)) throw new Error(`${nth}的对象只能是文件、文件夹或不限`);
    if (!MATCHES.has(match)) throw new Error(`${nth}的匹配方式不对`);
    if (!value) {
      if (match === 'path') {
        throw new Error(target === 'file'
          ? `${nth}的内容不能为空，请点「选择文件」选一个文件`
          : `${nth}的内容不能为空，请点「选择文件夹」选一个子文件夹`);
      }
      throw new Error(`${nth}的内容不能为空，请填写名字、扩展名或通配符`);
    }
    if (/[\r\n]/.test(value)) throw new Error(`${nth}的内容不能换行`);
    if (match === 'path') {
      // 指定文件夹路径：相对该组源文件夹根的路径，不许越出源根、不许带通配符；
      // 允许 .git 这类点开头段、中文和空格。
      const bad = value.startsWith('/') || value.endsWith('/')
        || value.split('/').some((seg) => seg === '..' || seg === '')
        || /[*?[\]{}\\]/.test(value);
      if (bad) {
        throw new Error(`${nth}的路径格式不对：填源文件夹下的相对路径，如 moviepilot/core，不要以 / 开头或结尾、不要含 ..、不要带通配符或反斜杠`);
      }
    }
    if (match === 'ext') {
      value = extensionOf(value);
      if (!value || /[\s/\\*?[\]{}]/.test(value)) {
        throw new Error(`${nth}的扩展名格式不对，请填 zip 或 .zip 这样的扩展名，不要带路径、空格或通配符`);
      }
    }
    return { action, target, match, value };
  });
}

function dedupe(list) {
  return [...new Set(list)];
}

// rclone 对带 / 的相对模式在目录遍历时有个实际细节：只给相对形式时，深层同名目录
// 可能进不去；补一份 **/ 前缀形式后，根目录与任意层级都能命中。带 / 开头（锚定根）
// 或 **/ 开头的模式尊重原意，不再补。
function pathVariants(pattern) {
  if (pattern.startsWith('/') || pattern.startsWith('**/')) return [pattern];
  if (pattern.includes('/')) return [pattern, `**/${pattern}`];
  return [pattern];
}

function folderVariants(pattern) {
  if (pattern.startsWith('/') || pattern.startsWith('**/')) return [pattern];
  return [pattern, `**/${pattern}`];
}

function literalPattern(rule) {
  const value = rule.match === 'glob' ? rule.value : rule.value.replace(/\/+$/, '');
  switch (rule.match) {
    case 'contains': return `*${escapeFilterLiteral(value)}*`;
    case 'exact': return escapeFilterLiteral(value);
    case 'ext': return `*.${escapeFilterLiteral(extensionOf(value))}`;
    case 'glob': return value;
    default: return value;
  }
}

function filePatterns(rule) {
  let pattern = literalPattern(rule);
  if (rule.match === 'glob') pattern = pattern.replace(/\/+$/, '');
  return pathVariants(pattern);
}

function folderPatterns(rule) {
  let base = literalPattern(rule);
  let selectChildren = false;
  if (rule.match === 'glob') {
    base = base.replace(/\/+$/, '');
    if (base.endsWith('/**')) base = base.slice(0, -3);
    else if (base.endsWith('/*')) selectChildren = true;
  }
  const out = [];
  for (const b of folderVariants(base)) {
    if (selectChildren) {
      out.push(`${b}/`, `${b}/**`);
    } else {
      const dir = b.endsWith('/') ? b : `${b}/`;
      out.push(dir, `${dir}**`);
    }
  }
  return dedupe(out);
}

export function patternsForFilterRule(rule) {
  // 指定文件夹路径：锚定到源根，只排除这个位置；同名文件夹在别的位置不受影响。
  // 不许再补 **/ 变体，否则锚定就失效了。path 值已在校验里排除了通配符，可直接拼。
  if (rule.match === 'path') {
    const anchored = `/${rule.value}`;
    if (rule.target === 'file') return [anchored];
    if (rule.target === 'folder') return [`${anchored}/`, `${anchored}/**`];
    return [`${anchored}/`, `${anchored}/**`, anchored];
  }
  if (rule.target === 'file') return filePatterns(rule);
  if (rule.target === 'folder') return folderPatterns(rule);
  return dedupe([...filePatterns(rule), ...folderPatterns(rule)]);
}

export function pairFilterRules(rawFilters) {
  const filters = normalizePairFilters(rawFilters);
  const rules = [];
  let hasInclude = false;
  for (const rule of filters) {
    if (rule.action === 'include') hasInclude = true;
    const sign = rule.action === 'include' ? '+' : '-';
    for (const pattern of patternsForFilterRule(rule)) rules.push(`${sign} ${pattern}`);
  }
  if (hasInclude) rules.push('- **');
  return rules;
}

// 一键排除预设（任务级开关 excludeDbTemp / excludeLogs / excludeTemp，存在任务对象上，
// 不进 pair.filters）：生成每组 pair 的 FilterRule 时追加到末尾，对每组 src 都生效；
// 取消勾选即干净去掉，老任务缺字段 = 全关。
// 1. 数据库临时文件：*-wal / *-shm / *-journal 是后缀式，已覆盖 .db-wal / .sqlite-wal /
//    .sqlite3-wal 等；另加 *.wal、*.shm（别的软件直接用 .wal 当预写日志扩展名）；绝不含 *.db、*.sqlite、*.sqlite3（主库是真数据，照常备份）。
// 2. 日志文件：*.log.* 覆盖 .log.1、.log.gz 这类滚动日志。
// 3. 其他临时、锁和未完成文件：*.bak 排以 .bak 结尾的，*.bak-* 排 .bak-20261112 这类带日期后缀的备份；
//    不用 *.bak*，它会误伤 foo.bakery 这类名字里含 .bak 的文件；
//    目录类（__pycache__、**/tmp/、**/temp/、**/.cache/）要同时排除目录本身和里面的内容，
//    并补 **/ 变体让任意层级都命中（与手填文件夹规则的生成口径一致）。
export const DB_TEMP_PATTERNS = ['*-wal', '*-shm', '*-journal', '*.journal', '*.db-wal', '*.db-shm', '*.db-journal', '*.wal', '*.shm'];
export const LOG_PATTERNS = ['*.log', '*.log.*', '*.out', '*.err'];
export const TEMP_PATTERNS = [
  '*.tmp', '*.temp', '*.swp', '*.swo', '*~', '.#*', '.#*#',
  '*.lock', '*.lck', '*.pid', '*.sock',
  '*.part', '*.partial', '*.crdownload', '*.download', '*.aria2', '*.!qB', '*.!ut', '*.bc', '*.bc!',
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '.fuse_hidden*', '.~lock.*#', '~$*',
  '*.pyc', '*.pyo', '*.bak', '*.bak-*', '*.old', '*.orig', '*.backup'
];
export const TEMP_DIR_PATTERNS = ['__pycache__', '**/tmp/', '**/temp/', '**/.cache/'];
function dirPresetRules(base) {
  const b = String(base).replace(/\/+$/, '');
  const variants = b.startsWith('**/') ? [b] : [b, `**/${b}`];
  const out = [];
  for (const v of variants) out.push(`- ${v}/`, `- ${v}/**`);
  return out;
}
export function presetFilterRules(task) {
  const rules = [];
  if (task?.excludeDbTemp) for (const p of DB_TEMP_PATTERNS) rules.push(`- ${p}`);
  if (task?.excludeLogs) for (const p of LOG_PATTERNS) rules.push(`- ${p}`);
  if (task?.excludeTemp) {
    for (const p of TEMP_PATTERNS) rules.push(`- ${p}`);
    for (const d of TEMP_DIR_PATTERNS) rules.push(...dirPresetRules(d));
  }
  return rules;
}
