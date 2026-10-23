import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { HelpTip, Icon } from '../components.jsx';

const TOKEN_HELP = '机器人令牌是建机器人时 Telegram 给你的一串字符，长得像「123456789:AAEh...」。获取方法：打开 Telegram → 搜索 @BotFather → 发送 /newbot → 按提示给机器人起名字 → 它会回你一串令牌，复制到这里。令牌等于机器人的钥匙，别发给别人。';
const CHATID_HELP = 'Chat ID 是「把通知发给谁」的编号，就是你自己的 Telegram 数字 ID。获取方法：先给你的机器人发任意一句话（比如「hi」，不发它没法主动找你），然后在 Telegram 里搜索 @userinfobot，它会直接回你的 Id（一串数字），抄到这里。也可以给机器人发完话后打开 https://api.telegram.org/bot<你的令牌>/getUpdates ，在返回内容里找 "chat":{"id": 后面的数字。';
const ADDRESS_HELP = '填你平时打开这个面板用的地址，比如 https://panel.example.com，或者 http://192.168.1.10:8080。填了之后，备份失败的 Telegram 通知末尾会带一条链接，点一下就直接跳到出错的那条记录。\n留空也没关系：通知照样发，只是不带链接。\n填错了（比如端口写错、域名写错）唯一的影响就是链接点开打不开，通知本身不受影响，回来改对就行。';

export default function Settings({ toast }) {
  const [tg, setTg] = useState(null); // { enabled, chatId, panelAddress, botToken }
  const [tokenSet, setTokenSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api.get('/settings').then((d) => {
      const t = d.settings?.telegram || {};
      setTg({ enabled: !!t.enabled, chatId: t.chatId || '', panelAddress: t.panelAddress || '', botToken: '' });
      setTokenSet(!!d.botTokenSet);
    }).catch(() => setTg({ enabled: false, chatId: '', panelAddress: '', botToken: '' }));
  }, []);

  if (!tg) return <div className="loading-page"><span className="spin" /> 加载中…</div>;
  const set = (k, v) => setTg((x) => ({ ...x, [k]: v }));
  const payload = () => ({ telegram: { enabled: tg.enabled, chatId: tg.chatId.trim(), panelAddress: tg.panelAddress.trim(), botToken: tg.botToken.trim() } });

  async function save() {
    setSaving(true);
    try {
      await api.put('/settings', payload());
      if (tg.botToken.trim()) setTokenSet(true);
      setTg((x) => ({ ...x, botToken: '' }));
      toast('设置已保存');
    } catch (e) { toast(e.message, true); }
    setSaving(false);
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

    </div>
  );
}
