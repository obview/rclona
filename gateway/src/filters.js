// #26：把任务里结构化的文件筛选规则翻译成 rclone 的 FilterRule。
// 规则顺序就是用户填写的顺序，rclone 按从上到下「第一次命中即定」处理；
// 只要存在任意一条「仅同步（include）」规则，末尾就补一条 - **，实现只同步命中项。

const ACTIONS = new Set(['include', 'exclude']);
const TARGETS = new Set(['file', 'folder', 'any']);
const MATCHES = new Set(['contains', 'exact', 'ext', 'glob']);

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
    if (!value) throw new Error(`${nth}的内容不能为空，请填写名字、扩展名或通配符`);
    if (/[\r\n]/.test(value)) throw new Error(`${nth}的内容不能换行`);
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
