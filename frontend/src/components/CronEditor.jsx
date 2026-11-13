import React from 'react';
import { WEEKDAYS } from '../util.js';

// Cron 编辑器（Rclone UI CronEditor 风）：六种定时方式 chips + cron 高级模式
// （单表达式输入 + 分/时/日/月/周五段格子 + 人话说明 + 常用预设）。
// 与后端 gateway/src/schedule.js 的口径一致：标准五段 cron，每段只认 *、数字、
// 逗号、横杠范围和 / 步长，不认 JAN/MON 这类英文名；日与星期都限定时任一命中即可。
// props：{ value, onChange }，value 是任务的 schedule 对象
// { type, time, weekdays, dayOfMonth, intervalHours, intervalDays, cron }。

const TYPES = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'hours', label: '每隔 N 小时' },
  { value: 'days', label: '每隔 N 天' },
  { value: 'cron', label: '高级 cron' },
];

const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const FIELD_LABELS = ['分', '时', '日', '月', '周'];
const FIELD_NAMES = ['分钟', '小时', '日期', '月份', '星期'];

// 与后端 parseCronField 同款校验：每段逗号分隔，每块是 * / 数字 / 范围 / 步长
function checkCron(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return 'cron 表达式要是五段：分 时 日 月 周，例如 30 3 * * *';
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = FIELD_RANGES[i];
    for (const part of parts[i].split(',')) {
      const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
      if (!m) return `cron「${FIELD_NAMES[i]}」部分写错了：「${part}」`;
      const step = m[3] ? Number(m[3]) : 1;
      if (step < 1) return `cron「${FIELD_NAMES[i]}」的步长要大于 0`;
      let a, b;
      if (m[1] === '*') { a = lo; b = hi; }
      else { a = Number(m[1]); b = m[2] != null ? Number(m[2]) : (m[3] ? hi : a); }
      if (a < lo || b > hi || a > b) return `cron「${FIELD_NAMES[i]}」超出范围（${lo}–${hi}）`;
    }
  }
  return '';
}

// 把常见 cron 翻成人话；复杂写法原样回显，不硬翻
function describeCron(cron) {
  const err = checkCron(cron);
  if (err) return { ok: false, text: err };
  const [mi, ho, dom, mo, dow] = String(cron).trim().split(/\s+/);
  const pad = (n) => String(n).padStart(2, '0');
  const isNum = (s) => /^\d+$/.test(s);
  const dowNames = (s) => s.split(',').map((x) => WEEKDAYS[Number(x) === 7 ? 0 : Number(x)]).filter(Boolean).join('、');
  let timePart = '';
  if (isNum(mi) && isNum(ho)) timePart = `${pad(ho)}:${pad(mi)}`;
  else if (isNum(mi) && ho === '*') timePart = `每小时的 ${pad(mi)} 分`;
  else if (mi.startsWith('*/') && ho === '*') timePart = `每 ${mi.slice(2)} 分钟`;
  else if (mi.startsWith('*/') && isNum(ho)) timePart = `每天 ${pad(ho)} 点起，每 ${mi.slice(2)} 分钟`;
  let freqPart = '';
  if (dow !== '*') freqPart = `每${dowNames(dow)}`;
  else if (isNum(dom)) freqPart = `每月 ${dom} 日`;
  else if (dom.startsWith('*/')) freqPart = `每 ${dom.slice(2)} 天`;
  else if (isNum(ho)) freqPart = '每天';
  else if (ho.startsWith('*/')) freqPart = `每 ${ho.slice(2)} 小时`;
  let monthPart = '';
  if (mo !== '*') monthPart = isNum(mo) ? `${mo} 月` : `${mo.split(',').join('、')} 月`;
  const bits = [monthPart, freqPart, timePart].filter(Boolean);
  if (!bits.length) return { ok: true, text: `按 cron 表达式 ${cron} 执行` };
  return { ok: true, text: `${bits.join(' ')}执行` };
}

const CRON_PRESETS = [
  { label: '每天 03:30', value: '30 3 * * *' },
  { label: '每小时整点', value: '0 * * * *' },
  { label: '每 15 分钟', value: '*/15 * * * *' },
  { label: '每周一 03:30', value: '30 3 * * 1' },
  { label: '每月 1 号 03:30', value: '30 3 1 * *' },
];

export default function CronEditor({ value, onChange }) {
  const v = value || {};
  const type = v.type || 'daily';
  const set = (patch) => onChange({ ...v, ...patch });
  const weekdays = v.weekdays && v.weekdays.length ? v.weekdays : [1];
  const cron = v.cron || '30 3 * * *';
  const cronParts = cron.trim().split(/\s+/);
  const desc = type === 'cron' ? describeCron(cron) : null;

  function setCronPart(i, val) {
    const parts = cron.trim().split(/\s+/);
    while (parts.length < 5) parts.push('*');
    parts[i] = val.trim() === '' ? '*' : val.trim();
    set({ cron: parts.join(' ') });
  }
  function toggleWeekday(d) {
    const next = weekdays.includes(d) ? weekdays.filter((x) => x !== d) : [...weekdays, d].sort((a, b) => a - b);
    set({ weekdays: next });
  }

  return (
    <div>
      <div className="cron-chips">
        {TYPES.map((t) => (
          <button key={t.value} type="button" className={`cron-chip${type === t.value ? ' on' : ''}`}
            onClick={() => set({ type: t.value })}>{t.label}</button>
        ))}
      </div>

      {type === 'weekly' && (
        <div className="wd-chips" style={{ marginBottom: 10 }}>
          {WEEKDAYS.map((w, i) => (
            <button type="button" key={i}
              className={`wd-chip${weekdays.includes(i) ? ' on' : ''}`}
              onClick={() => toggleWeekday(i)}>{w.replace('周', '')}</button>
          ))}
        </div>
      )}
      {type === 'monthly' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>每月</span>
          <input className="input" type="number" min="1" max="31" style={{ width: 84 }}
            value={v.dayOfMonth ?? 1} onChange={(e) => set({ dayOfMonth: e.target.value })} />
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>号（填 31 时，短月份自动按最后一天跑）</span>
        </div>
      )}
      {type === 'hours' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>每隔</span>
          <input className="input" type="number" min="1" max="720" style={{ width: 84 }}
            value={v.intervalHours ?? 6} onChange={(e) => set({ intervalHours: e.target.value })} />
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>小时执行一次（从保存时刻起算）</span>
        </div>
      )}
      {type === 'days' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>每隔</span>
          <input className="input" type="number" min="1" max="365" style={{ width: 84 }}
            value={v.intervalDays ?? 3} onChange={(e) => set({ intervalDays: e.target.value })} />
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>天，在下面时间执行一次</span>
        </div>
      )}
      {type === 'cron' && (
        <>
          <input className="input" value={cron} onChange={(e) => set({ cron: e.target.value })}
            placeholder="分 时 日 月 周，例如 30 3 * * *" style={{ fontFamily: 'ui-monospace, Menlo, monospace' }} />
          <div className="cron-grid" style={{ marginTop: 10 }}>
            {FIELD_LABELS.map((label, i) => (
              <div className="cron-cell" key={label}>
                <label>{label}<span className="hint">（{FIELD_RANGES[i][0]}–{FIELD_RANGES[i][1]}）</span></label>
                <input className="input" value={cronParts[i] ?? '*'} aria-label={`cron ${FIELD_NAMES[i]}`}
                  onChange={(e) => setCronPart(i, e.target.value)} />
              </div>
            ))}
          </div>
          <div className={`cron-desc${desc.ok ? '' : ' bad'}`}>{desc.ok ? `⏱ ${desc.text}` : `⚠️ ${desc.text}`}</div>
          <div className="cron-presets">
            {CRON_PRESETS.map((p) => (
              <button key={p.label} type="button" className="cron-preset"
                onClick={() => set({ cron: p.value })}>{p.label}</button>
            ))}
          </div>
          <div style={{ color: 'var(--text-3)', fontSize: 12.5, marginTop: 8 }}>
            给熟悉 cron 的用户用的高级写法（五段：分 时 日 月 周），不熟悉就用上面几种方式，别改这个。
          </div>
        </>
      )}
      {type !== 'hours' && type !== 'cron' && (
        <input className="input" type="time" value={v.time || '03:30'} style={{ maxWidth: 200 }}
          onChange={(e) => set({ time: e.target.value })} />
      )}
    </div>
  );
}
