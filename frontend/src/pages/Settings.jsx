import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { HelpTip, Icon } from '../components.jsx';

const TOKEN_HELP = '机器人令牌是建机器人时 Telegram 给你的一串字符，长得像「123456789:AAEh...」。获取方法：打开 Telegram → 搜索 @BotFather → 发送 /newbot → 按提示给机器人起名字 → 它会回你一串令牌，复制到这里。令牌等于机器人的钥匙，别发给别人。';
const CHATID_HELP = 'Chat ID 是「把通知发给谁」的编号，就是你自己的 Telegram 数字 ID。获取方法：先给你的机器人发任意一句话（比如「hi」，不发它没法主动找你），然后在 Telegram 里搜索 @userinfobot，它会直接回你的 Id（一串数字），抄到这里。也可以给机器人发完话后打开 https://api.telegram.org/bot<你的令牌>/getUpdates ，在返回内容里找 "chat":{"id": 后面的数字。';
const ADDRESS_HELP = '填你平时打开这个面板用的地址，比如 https://panel.example.com，或者 http://192.168.1.10:8080。填了之后，备份失败的 Telegram 通知末尾会带一条链接，点一下就直接跳到出错的那条记录。\n留空也没关系：通知照样发，只是不带链接。\n填错了（比如端口写错、域名写错）唯一的影响就是链接点开打不开，通知本身不受影响，回来改对就行。';

const CRYPT_HELP = '这是给「备份加密」用的密码：在任务里打开「备份加密」后，备份到目标网盘的文件会被加密（文件名和内容都是乱码），只有这把密码能解开。所有开了加密的任务共用这一把。\n密码只保存在这台服务器上，界面永远不显示原文；保存时服务器会先把它混淆再入库，不是明文放着。';

export default function Settings({ toast }) {
  const [tg, setTg] = useState(null); // { enabled, chatId, panelAddress, botToken }
  const [tokenSet, setTokenSet] = useState(false);
  const [capPct, setCapPct] = useState(90);
  const [cryptPw, setCryptPw] = useState('');
  const [cryptSet, setCryptSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    api.get('/settings').then((d) => {
      const t = d.settings?.telegram || {};
      setTg({ enabled: !!t.enabled, chatId: t.chatId || '', panelAddress: t.panelAddress || '', botToken: '' });
      setTokenSet(!!d.botTokenSet);
      setCapPct(d.settings?.capacity?.alertPercent ?? 90);
      setCryptSet(!!d.cryptPasswordSet);
    }).catch(() => setTg({ enabled: false, chatId: '', panelAddress: '', botToken: '' }));
  }, []);

  if (!tg) return <div className="loading-page"><span className="spin" /> 加载中…</div>;
  const set = (k, v) => setTg((x) => ({ ...x, [k]: v }));
  const payload = () => ({
    telegram: { enabled: tg.enabled, chatId: tg.chatId.trim(), panelAddress: tg.panelAddress.trim(), botToken: tg.botToken.trim() },
    capacity: { alertPercent: Math.trunc(Number(capPct) || 0) },
    ...(cryptPw.trim() ? { backupCryptPassword: cryptPw.trim() } : {})
  });

  async function save() {
    setSaving(true);
    try {
      await api.put('/settings', payload());
      if (tg.botToken.trim()) setTokenSet(true);
      if (cryptPw.trim()) { setCryptSet(true); setCryptPw(''); }
      setTg((x) => ({ ...x, botToken: '' }));
      toast('设置已保存');
    } catch (e) { toast(e.message, true); }
    setSaving(false);
  }
  async function clearCrypt() {
    if (!confirm('确定清除已保存的备份加密密码吗？清除后，开了加密的任务在重新设置密码之前会备份失败。（已经加密过的备份不受影响，但没有密码就再也解不开了）')) return;
    try {
      await api.put('/settings', { clearCryptPassword: true });
      setCryptSet(false); setCryptPw('');
      toast('备份加密密码已清除');
    } catch (e) { toast(e.message, true); }
  }
  async function importFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      let doc;
      try { doc = JSON.parse(text); } catch { throw new Error('这个文件不是有效的 JSON，确认选的是「导出完整备份」下载的那个文件'); }
      // #33：完整备份（版本 2）导入是「还原」——同名会覆盖，先把将覆盖/新增的清单弹给用户确认
      if (doc && doc.app === 'rclona' && doc.version === 2) {
        const [rd, td] = await Promise.all([api.get('/remotes'), api.get('/tasks')]);
        const curR = new Set((rd.remotes || []).map((x) => x.name));
        const curT = new Set((td.tasks || []).map((x) => x.name));
        const rNames = (doc.remotes || []).map((x) => x.name).filter(Boolean);
        const tNames = (doc.tasks || []).map((x) => x.name).filter(Boolean);
        const rOver = rNames.filter((n) => curR.has(n));
        const rAdd = rNames.filter((n) => !curR.has(n));
        const tOver = tNames.filter((n) => curT.has(n));
        const tAdd = tNames.filter((n) => !curT.has(n));
        const lines = ['即将按这个备份文件还原：'];
        if (rOver.length) lines.push(`· 覆盖网盘 ${rOver.length} 个：${rOver.join('、')}`);
        if (rAdd.length) lines.push(`· 新增网盘 ${rAdd.length} 个：${rAdd.join('、')}`);
        if (tOver.length) lines.push(`· 覆盖任务 ${tOver.length} 个：${tOver.join('、')}`);
        if (tAdd.length) lines.push(`· 新增任务 ${tAdd.length} 个：${tAdd.join('、')}`);
        if (doc.auth) lines.push('· 面板登录账号也会被还原成备份里的那个');
        lines.push('Telegram、备份加密密码等设置也会按文件恢复。确定要继续吗？');
        if (!window.confirm(lines.join('\n'))) { setImporting(false); return; }
      }
      const d = await api.post('/settings/import', { data: doc });
      const r = d.report || {};
      const parts = [];
      if (r.remotesAdded?.length) parts.push(`新增网盘 ${r.remotesAdded.length} 个`);
      if (r.remotesReplaced?.length) parts.push(`覆盖网盘 ${r.remotesReplaced.length} 个`);
      if (r.remotesUpdated?.length) parts.push(`更新网盘 ${r.remotesUpdated.length} 个（旧格式文件：只更新了非密钥部分）`);
      if (r.tasksAdded?.length) parts.push(`新增任务 ${r.tasksAdded.length} 个`);
      if (r.tasksReplaced?.length) parts.push(`覆盖任务 ${r.tasksReplaced.length} 个`);
      if (r.tasksSkipped?.length) parts.push(`同名任务跳过 ${r.tasksSkipped.length} 个`);
      if (r.authRestored) parts.push('面板登录已还原');
      toast(parts.length ? `导入完成：${parts.join('；')}` : '导入完成：没有变化', false);
      if (r.missingSecrets?.length) toast(`这几个网盘是旧格式文件导入的、还缺密钥：${r.missingSecrets.join('、')}（已存的密钥没被动；新加的请到「网盘管理」点「编辑」补填）`, true);
      if (r.errors?.length) toast(`有 ${r.errors.length} 项没导入成功：${r.errors[0]}`, true);
    } catch (err) { toast(err.message, true); }
    setImporting(false);
  }
  async function testTelegram() {
    setTesting(true);
    try {
      await api.put('/settings', payload());
      if (tg.botToken.trim()) setTokenSet(true);
      setTg((x) => ({ ...x, botToken: '' }));
      await api.post('/settings/test-telegram');
      toast('测试通知已发出，请看你的 Telegram');
    } catch (e) { toast(e.message, true); }
    setTesting(false);
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">设置</div>
          <div className="page-sub">备份失败、网盘异常时如何通知你</div>
        </div>
        <div className="spacer" />
        <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存设置'}</button>
      </div>

      <div className="card card-pad section-gap">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="card-title">Telegram 通知</div>
            <div className="card-sub">备份失败、网盘连接失效（及恢复）时，让 Telegram 机器人第一时间告诉你，消息里带失败阶段与原因</div>
          </div>
          <label className="switch">
            <input type="checkbox" checked={tg.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            <span className="track" />
          </label>
        </div>
        {tg.enabled && (
          <>
            <div className="form-grid" style={{ marginTop: 16 }}>
              <div className="field">
                <label>机器人令牌 Bot Token * <HelpTip text={TOKEN_HELP} /></label>
                <input className="input" type="password" autoComplete="new-password"
                  value={tg.botToken} onChange={(e) => set('botToken', e.target.value)}
                  placeholder={tokenSet ? '已保存（留空表示不改）' : '粘贴 @BotFather 给你的令牌'} />
              </div>
              <div className="field">
                <label>Chat ID（发给谁） * <HelpTip text={CHATID_HELP} /></label>
                <input className="input" value={tg.chatId} onChange={(e) => set('chatId', e.target.value)}
                  placeholder="你的 Telegram 数字 ID" />
              </div>
              <div className="field full">
                <label>面板访问地址（可不填） <HelpTip text={ADDRESS_HELP} /></label>
                <input className="input" value={tg.panelAddress} onChange={(e) => set('panelAddress', e.target.value)}
                  placeholder="例如 https://panel.example.com 或 http://192.168.1.10:8080" />
                <span className="hint">填了它，失败通知末尾会带一条链接，点一下直接跳到出错的那条记录；不填则只发文字通知。</span>
              </div>
            </div>
            <div className="info-box" style={{ marginTop: 14 }}>
              三步配好：① 在 Telegram 里找 <b>@BotFather</b> 发 <b>/newbot</b> 建一个机器人，拿到令牌填到上面；
              ② 打开你刚建的机器人，随便给它发一句话；③ 搜索 <b>@userinfobot</b> 拿到你的数字 ID，填到 Chat ID。
              每一步点字段旁边的圆圈问号有详细说明。
            </div>
            <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn btn-ghost btn-sm" disabled={testing} onClick={testTelegram}>
                <Icon name="bell" size={14} /> {testing ? '发送中…' : '先存并发送测试通知'}
              </button>
              <span style={{ color: 'var(--text-3)', fontSize: 12.5 }}>点了没收到？多半是还没给机器人发过第一句话，或 Chat ID 填错了。</span>
            </div>
          </>
        )}
      </div>

      <div className="card card-pad section-gap">
        <div className="card-title">备份加密密码 <HelpTip text={CRYPT_HELP} /></div>
        <div className="card-sub">给任务里的「备份加密」开关用的密码，所有开了加密的任务共用这一把；在这里填，不在任务里填</div>
        <div className="note-box" style={{ marginTop: 12 }}>
          ⚠️ <b>这把密码一旦丢失，加密过的备份就全部无法恢复，谁也救不回来。</b>请把它当成重要密码保管（比如记进密码管理器），不要只记在脑子里。
        </div>
        <div className="form-grid" style={{ marginTop: 14 }}>
          <div className="field">
            <label>备份加密密码 {cryptSet ? '（已设置）' : '（未设置）'}</label>
            <input className="input" type="password" autoComplete="new-password"
              value={cryptPw} onChange={(e) => setCryptPw(e.target.value)}
              placeholder={cryptSet ? '已保存，留空表示不改；要换就填新密码' : '填一个你记得住的长密码'} />
            <span className="hint">填好后点页面右上角「保存设置」生效；改密码后，之前用旧密码加密的备份要用旧密码才能读，请谨慎更换。</span>
          </div>
        </div>
        {cryptSet && (
          <div style={{ marginTop: 10 }}>
            <button className="btn-link danger" onClick={clearCrypt}>清除已保存的密码</button>
            <span style={{ color: 'var(--text-3)', fontSize: 12.5, marginLeft: 8 }}>清除后开了加密的任务会备份失败，直到重新设置密码。</span>
          </div>
        )}
      </div>

      <div className="card card-pad section-gap">
        <div className="card-title">网盘容量提醒</div>
        <div className="card-sub">每天凌晨自检时顺带看一眼每个网盘用了多少；超过下面的比例，就用 Telegram 提醒你一次（降回来再涨上去会再提醒）</div>
        <div className="form-grid" style={{ marginTop: 14 }}>
          <div className="field">
            <label>已用容量达到多少 % 时提醒</label>
            <input className="input" type="number" min="0" max="100" style={{ width: 120 }}
              value={capPct} onChange={(e) => setCapPct(e.target.value)} />
            <span className="hint">默认 90%；填 0 表示关闭容量提醒。改完点右上角「保存设置」。</span>
          </div>
        </div>
      </div>

      <div className="card card-pad section-gap">
        <div className="card-title">配置备份 / 还原</div>
        <div className="card-sub">把任务、网盘和设置打包带走（换服务器、留底都方便），导入后完整还原、不用再补填任何密码</div>
        <div className="note-box" style={{ marginTop: 12 }}>
          <b>导出的文件等于你全部网盘的钥匙</b>：里面有每个网盘的登录密钥、Telegram 机器人令牌和备份加密密码。
          只许存在你自己的设备上，<b>不要发给任何人、不要通过聊天软件传输、不要上传到公开网盘</b>。
          导入（还原）时，同名的网盘和任务会以文件为准被覆盖，新的补进来；任务的启用状态和定时也按文件恢复；面板登录账号也会一并还原。
          （老版本导出的「不含密钥」文件也能导入，只是同名网盘的密钥不会被动、新网盘仍要补填密码。）
        </div>
        <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <a className="btn btn-ghost btn-sm" href="/api/settings/export">导出完整备份（下载 JSON）</a>
          <button className="btn btn-ghost btn-sm" disabled={importing} onClick={() => fileRef.current?.click()}>
            {importing ? '导入中…' : '导入备份（选导出的 JSON）'}
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={importFile} />
        </div>
      </div>

    </div>
  );
}
