/**
 * dsh-bili-reply —— 浏览器半端（设置在「设置」里的独立一页）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本（抄 dsh-bili-scroll / dsh-meme 的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: 'dsh-bili-reply',            // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: ['slots'], apply(ctx) {...} } },
 *     })
 *
 * ⭐ 进「设置」用 slots（不是自己糊全屏 overlay）：
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'bili-reply', order: 40, label: 'B站自动回复' },
 *       () => h(Panel),
 *     ))
 *
 * 这一页要满足的形状：
 *   · 总开关 → 打开之后下面才展开子开关（30 秒补检 / 只看模式）
 *   · 数字项能自己填（限速、视频时长上限、文案字数）
 *   · 账号绑定必须在设置页里（Cookie 直接粘贴，显示剩余天数）
 *   · 会发东西出去的（自动回复）默认关；要跑本地转写的（video-watch）也默认关
 *   · 输入框必须绑「本地草稿」：页面每几秒轮询 /status，服务端那份会把 config 盖掉
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-reply',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/bili-reply'
    const jget = async (p) => (await fetch(API + p, { credentials: 'same-origin' })).json()
    const jpost = async (p, body) => (await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })).json()

    const CSS = `
[data-br-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 10px;max-width:660px;}
[data-br-sec]{display:flex;flex-direction:column;gap:8px;}
[data-br-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);margin-top:4px;}
[data-br-row]{display:flex;align-items:center;gap:10px;}
[data-br-grow]{flex:1;min-width:0;}
[data-br-label]{font-size:13px;}
[data-br-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-br-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-br-sw][data-on]{background:#3b82f6;}
[data-br-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-br-sw][data-on] i{left:19px;}
[data-br-sw][disabled]{opacity:.45;cursor:default;}
[data-br-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-br-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-l2,rgba(255,255,255,.04));color:inherit;outline:none;}
[data-br-input]:focus{border-color:#3b82f6;}
[data-br-num]{width:96px;flex:none;text-align:right;}
[data-br-textarea]{min-height:74px;resize:vertical;font-family:inherit;line-height:1.5;}
[data-br-btn]{padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-l2,rgba(255,255,255,.05));color:inherit;}
[data-br-btn]:hover{background:var(--dsw-alias-bg-l3,rgba(255,255,255,.1));}
[data-br-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-br-btn][data-primary]:hover{background:#2f6fd8;}
[data-br-btn][disabled]{opacity:.5;cursor:default;}
[data-br-btns]{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;}
[data-br-tag]{display:inline-block;padding:1px 7px;border-radius:6px;font-size:11px;
  background:var(--dsw-alias-bg-l3,rgba(128,128,128,.2));}
[data-br-tag][data-good]{background:rgba(52,199,89,.18);color:#34c759;}
[data-br-tag][data-warn]{background:rgba(255,159,10,.18);color:#ff9f0a;}
[data-br-tag][data-bad]{background:rgba(255,69,58,.18);color:#ff453a;}
[data-br-pre]{margin:0;padding:10px;border-radius:8px;font-size:11px;line-height:1.6;overflow:auto;max-height:260px;
  white-space:pre-wrap;word-break:break-all;background:var(--dsw-alias-bg-l2,rgba(0,0,0,.25));
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));font-family:ui-monospace,Consolas,monospace;}
[data-br-kv]{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--dsw-alias-label-secondary,#b0b6bd);}
[data-br-hint]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-br-err]{font-size:11px;line-height:16px;color:#ff453a;white-space:pre-wrap;}
[data-br-ok]{font-size:11px;line-height:16px;color:#34c759;white-space:pre-wrap;}
[data-br-mono]{font-family:ui-monospace,Consolas,monospace;font-size:11px;}
[data-br-records]{display:flex;flex-direction:column;gap:8px;}
[data-br-rec]{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-l2,rgba(255,255,255,.04));
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));}
`

    /* ────────────── 小部件 ────────────── */

    function useStatus(intervalMs) {
      const [st, setSt] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const r = await jget('/status')
            if (alive && r && r.ok) setSt(r)
          } catch { /* 宿主还没起来 */ }
        }
        tick()
        const t = setInterval(tick, intervalMs || 5000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs])
      return [st, setSt]
    }

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-br-sw': '',
        'data-on': on ? '' : undefined,
        disabled: !!disabled,
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function Row({ label, note, children }) {
      return h('div', { 'data-br-row': '' },
        h('div', { 'data-br-grow': '' },
          h('div', { 'data-br-label': '' }, label),
          note ? h('div', { 'data-br-note': '' }, note) : null),
        children)
    }

    function NumInput({ value, onCommit, disabled }) {
      const [draft, setDraft] = React.useState(null)
      const v = draft === null ? String(value ?? '') : draft
      return h('input', {
        'data-br-input': '',
        'data-br-num': '',
        type: 'number',
        min: 0,
        value: v,
        disabled: !!disabled,
        onChange: (e) => setDraft(e.target.value),
        onBlur: () => {
          const n = Math.floor(Number(draft))
          setDraft(null)
          if (draft !== null && Number.isFinite(n) && n >= 0) onCommit(n)
        },
      })
    }

    function TextInput({ value, onCommit, placeholder, disabled, mono }) {
      const [draft, setDraft] = React.useState(null)
      const v = draft === null ? String(value || '') : draft
      return h('input', {
        'data-br-input': '',
        style: mono ? { fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '11px' } : undefined,
        value: v,
        placeholder: placeholder || '',
        disabled: !!disabled,
        onChange: (e) => setDraft(e.target.value),
        onBlur: () => { const s = draft; setDraft(null); if (s !== null && s !== String(value || '')) onCommit(s) },
      })
    }

    function Btn({ children, onClick, disabled, primary }) {
      return h('button', { 'data-br-btn': '', 'data-primary': primary ? '' : undefined, disabled: !!disabled, onClick }, children)
    }

    function Tag({ text, tone }) {
      return h('span', { 'data-br-tag': '', 'data-good': tone === 'good' ? '' : undefined, 'data-warn': tone === 'warn' ? '' : undefined, 'data-bad': tone === 'bad' ? '' : undefined }, text)
    }

    /** 记录里的时间：优先用 @ 通知时间（atTime 秒），退化为写入时间 t */
    function fmtAt(r) {
      const sec = Number(r && r.atTime)
      const d = sec > 1_000_000_000 ? new Date(sec * 1000) : new Date(String((r && r.t) || '').replace(' ', 'T'))
      if (Number.isNaN(d.getTime())) return String((r && r.t) || '')
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    /* ────────────── 设置页正文 ────────────── */

    function Panel() {
      const [st, setSt] = useStatus(5000)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      const [cookieDraft, setCookieDraft] = React.useState(null)
      // 数字草稿：服务端 config 每个轮询都会回来，直接绑输入框会被冲掉
      const [numDraft, setNumDraft] = React.useState({})
      const [adv, setAdv] = React.useState(null)
      const [records, setRecords] = React.useState(null)
      const [recBusy, setRecBusy] = React.useState(false)

      const cfg = st || {}
      const say = (text, tone) => { setMsg(text); setMsgTone(tone || '') }

      const patch = async (p, what) => {
        setBusy(JSON.stringify(p))
        try {
          const r = await jpost('/config', p)
          if (!r || r.ok === false) { say('保存失败：' + ((r && r.error) || '未知原因'), 'warn'); return }
          say(what ? `${what}：已保存` : '已保存', 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onCheck = async () => {
        setBusy('check')
        say('')
        try {
          const r = await jpost('/check', {})
          if (r && r.ok) say('已经在后台检查，刷新看下面的日志', 'good')
          else say((r && r.error) || '没跑起来', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onTest = async () => {
        setBusy('test')
        say('')
        try {
          const r = await jpost('/test', {})
          if (r && r.ok) say(`登录态有效：${r.account}（mid=${r.mid}），${r.note}`, 'good')
          else say((r && r.error) || '测试失败', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      // 被 @ 与回复记录：不常驻刷新，点按钮才拉最近 1 天
      const onLoadRecords = async () => {
        setRecBusy(true)
        say('')
        try {
          const r = await jget('/records?hours=24')
          if (r && r.ok) {
            setRecords(r.items || [])
            say(`最近 1 天：${r.items.length} 条记录`, r.items.length ? 'good' : '')
          } else say((r && r.error) || '读取失败', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setRecBusy(false) }
      }

      const onSaveCookie = async () => {
        const text = String(cookieDraft ?? cfg.cookie ?? '').trim()
        if (!text) { say('先粘贴 Cookie 再保存', 'warn'); return }
        setBusy('cookie')
        try {
          const r = await jpost('/save-cookie', { cookie: text })
          if (r && r.ok) {
            setCookieDraft(null)
            const d = r.cookieDaysLeft
            say(d === null ? 'Cookie 已保存' : `Cookie 已保存，SESSDATA 还有 ${d} 天到期`, 'good')
          } else say((r && r.error) || '保存失败', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const enabled = !!cfg.enabled
      const cookieOk = !!cfg.cookieOk
      const days = cfg.cookieDaysLeft

      const statusTag = !enabled
        ? Tag({ text: '已关闭', tone: '' })
        : (!cfg.running ? Tag({ text: '运行中', tone: 'good' }) : Tag({ text: '正在检查', tone: 'warn' }))
      const loginTag = !cookieOk
        ? Tag({ text: '未绑定账号', tone: 'bad' })
        : (days !== null && days <= 3 ? Tag({ text: `Cookie 快过期（${days} 天）`, tone: 'bad' }) : Tag({ text: `账号：${cfg.accountName || '已绑定'}（${days === null ? '?' : days} 天）`, tone: 'good' }))

      return h('div', { 'data-br-page': '' },

        // ── 顶部状态 ──
        h('div', { 'data-br-sec': '' },
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-label': '', style: { fontSize: '14px', fontWeight: 600 } }, 'B站自动回复'),
              h('div', { 'data-br-note': '' }, `${cfg.replyAll ? '回复所有人' : '只回主人 UID 的 @'}${cfg.watchReplies ? ' + 回复我的' : ''}；纯 HTTP 轮询，不占浏览器`)),
            statusTag, loginTag),
          h('div', { 'data-br-kv': '' },
            h('span', {}, `上次检查：${cfg.lastCheck || '还没跑过'}`),
            h('span', {}, `上次结果：${cfg.lastResult || '—'}`),
            h('span', {}, `游标：${cfg.cursor || 0}`),
            h('span', {}, `已处理：${cfg.seenCount || 0} 条`)),
          msg ? h('div', { 'data-br-ok': msgTone === 'warn' ? '' : '', style: msgTone === 'warn' ? { color: '#ff453a' } : undefined }, msg) : null),

        // ── 总开关 ──
        h('div', { 'data-br-sec': '' },
          h('div', { 'data-br-h': '' }, '自动回复'),
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-label': '' }, '自动回复（总开关）'),
              h('div', { 'data-br-note': '' }, '打开后每分钟检查一次「@我的」，发现主人的 @ 就自动分析视频、写评论、发楼中楼')),
            Switch({ on: enabled, onChange: (v) => patch({ enabled: v }, '自动回复') })),
          enabled ? h('div', { 'data-br-sub': '' },
            h('div', { 'data-br-row': '' },
              h('div', { 'data-br-grow': '' },
                h('div', { 'data-br-label': '' }, '30 秒补检'),
                h('div', { 'data-br-note': '' }, '每轮检查完，过 30 秒再查一次（新 @ 不用等满 1 分钟）')),
              Switch({ on: !!cfg.secondPass, onChange: (v) => patch({ secondPass: v }, '30 秒补检') })),
            h('div', { 'data-br-row': '' },
              h('div', { 'data-br-grow': '' },
                h('div', { 'data-br-label': '' }, '只看模式'),
                h('div', { 'data-br-note': '' }, '发现 @ 只写日志、不自动回复 —— 想先观察一阵时打开')),
              Switch({ on: !!cfg.noReply, onChange: (v) => patch({ noReply: v }, '只看模式') }))) : null),

        // ── 回复范围 ──
        h('div', { 'data-br-sec': '' },
          h('div', { 'data-br-h': '' }, '回复范围'),
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-label': '' }, '回复所有人'),
              h('div', { 'data-br-note': '' }, '打开后任何人「@我」都会自动回复；关闭时只回主人 UID 的 @。主人自己的 @ 永远优先、不受下面限流限制')),
            Switch({ on: !!cfg.replyAll, onChange: (v) => patch({ replyAll: v }, '回复所有人') })),
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-label': '' }, '回复我的（别人回复了我的评论）'),
              h('div', { 'data-br-note': '' }, '打开后，有人回复我发过的评论也会自动接着回；同样受下面限流约束，默认关闭')),
            Switch({ on: !!cfg.watchReplies, onChange: (v) => patch({ watchReplies: v }, '回复我的') })),
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-label': '' }, '主人 UID'),
              h('div', { 'data-br-note': '' }, cfg.replyAll ? '「回复所有人」已打开；这个 UID 的 @ 永远优先处理、不受限流' : '只有这个 UID 的「@我」会自动回复；其他人 @ 一律不处理')),
            NumInput({
              value: cfg.ownerMid,
              onCommit: (v) => patch({ ownerMid: v }, '主人 UID'),
            })),
          h('div', { 'data-br-note': '' }, `当前登录账号：${cfg.accountName || '（未获取）'}${cfg.selfMid ? `（mid=${cfg.selfMid}）` : ''}`)),

        // ── 节奏 ──
        h('div', { 'data-br-sec': '' },
          h('div', { 'data-br-h': '' }, '回复节奏'),
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-label': '' }, '两条之间最少隔几分钟'),
              h('div', { 'data-br-note': '' }, '只对「回复其他人」生效；主人的 @ 永远优先、不受限。建议 3 分钟以上')),
            NumInput({ value: cfg.rateLimitMin, onCommit: (v) => patch({ rateLimitMin: v }, '限速') })),
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-label': '' }, '每个时间窗口最多回复几条'),
              h('div', { 'data-br-note': '' }, cfg.maxReplies > 0
                ? `只对「回复其他人」生效；主人的 @ 不计入、不受限。本窗口剩 ${cfg.quotaLeft ?? '?'} / ${cfg.maxReplies} 条（已回 ${cfg.repliesInWindow || 0} 条）；${Number(cfg.quotaLeft) > 0 ? '现在就有额度' : (cfg.nextQuotaAt ? `额度用完了，约 ${new Date(cfg.nextQuotaAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 恢复 1 条` : '额度用完了')}`
                : '只对「回复其他人」生效；主人的 @ 不计入、不受限。0 = 不限（不限制条数）')),
            NumInput({ value: cfg.maxReplies, onCommit: (v) => patch({ maxReplies: v }, '最多回复条数') })),
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-label': '' }, '时间窗口（分钟）'),
              h('div', { 'data-br-note': '' }, '配合上一项，比如「60 分钟内最多 5 条」；主人的 @ 不受影响')),
            NumInput({ value: cfg.maxRepliesWindowMin, onCommit: (v) => patch({ maxRepliesWindowMin: v }, '时间窗口') })),
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-label': '' }, '视频时长上限（分钟）'),
              h('div', { 'data-br-note': '' }, '超过就不看（0 = 不限）；10 分钟以上的转写会很久')),
            NumInput({ value: cfg.maxVideoMin, onCommit: (v) => patch({ maxVideoMin: v }, '视频上限') })),
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-label': '' }, '回复最多多少字'),
              h('div', { 'data-br-note': '' }, '写文案时限制输出长度，默认 120')),
            NumInput({ value: cfg.replyChars, onCommit: (v) => patch({ replyChars: v }, '文案字数') }))),

        // ── 人设 ──
        h('div', { 'data-br-sec': '' },
          h('div', { 'data-br-h': '' }, '人设'),
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-label': '' }, '人设文件路径（.md）'),
              h('div', { 'data-br-note': '' }, '填一个 .md 文件路径，回复会按里面的人设说话（称呼、语气、身份）；留空 = 内置默认「大肥鱼助手」人设。人设里的称呼规则仍然优先：只有主人 @ 才会叫「主人」，其他人叫「你」')),
            null),
          TextInput({ value: cfg.personaFile, placeholder: '留空 = 内置默认人设（例：E:\\大肥鱼人设\\persona.md）', mono: true, onCommit: (v) => patch({ personaFile: v }, '人设路径') })),

        // ── 账号绑定 ──
        h('div', { 'data-br-sec': '' },
          h('div', { 'data-br-h': '' }, '账号绑定（Cookie）'),
          h('div', { 'data-br-hint': '' }, '从浏览器 F12 →「网络(Network)」→ 随便点一个 bilibili.com 请求 → 请求头里复制整段 Cookie（要含 SESSDATA 和 bili_jct），粘到下面。Cookie 只存在本机插件家目录里。'),
          h('textarea', {
            'data-br-input': '',
            'data-br-textarea': '',
            value: String(cookieDraft ?? cfg.cookie ?? ''),
            onChange: (e) => setCookieDraft(e.target.value),
            placeholder: 'SESSDATA=xxx; bili_jct=xxx; buvid3=xxx; ...',
          }),
          h('div', { 'data-br-btns': '' },
            Btn({ children: '保存 Cookie', onClick: onSaveCookie, disabled: busy === 'cookie', primary: true }),
            Btn({ children: '测试登录', onClick: onTest, disabled: busy === 'test' }),
            cookieOk ? Btn({ children: '清空 Cookie', onClick: async () => { setCookieDraft(''); await jpost('/save-cookie', { cookie: '' }); say('Cookie 已清空', 'good') } }) : null),
          h('div', { 'data-br-note': '' },
            cookieOk
              ? `已绑定${days === null ? '' : `，SESSDATA 还有 ${days} 天到期`}。过期前设置页会标黄/红，到时间记得换。`
              : '还没绑定 Cookie —— 绑上之前无法检查「@我的」。')),

        // ── 高级 ──
        h('div', { 'data-br-sec': '' },
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-h': '' }, '高级'),
              h('div', { 'data-br-note': '' }, '一般不用动；dsh 生成文案、video-watch 做转写')),
            Btn({ children: adv ? '收起' : '展开', onClick: () => setAdv(adv ? null : {}) })),
          adv ? h('div', { 'data-br-sub': '' },
            h('div', { 'data-br-label': '' }, 'dsh 路径'),
            TextInput({ value: cfg.dshBin, placeholder: '留空 = PATH 里的 dsh', mono: true, onCommit: (v) => patch({ dshBin: v }, 'dsh 路径') }),
            h('div', { 'data-br-label': '' }, 'headless profile'),
            TextInput({ value: cfg.headlessProfile, placeholder: 'headless', onCommit: (v) => patch({ headlessProfile: v }, 'profile') }),
            h('div', { 'data-br-label': '' }, 'video-watch 目录'),
            TextInput({ value: cfg.videoWatchDir, placeholder: '留空 = $DSH_HOME/skills/video-watch', mono: true, onCommit: (v) => patch({ videoWatchDir: v }, 'video-watch 目录') }),
            h('div', { 'data-br-label': '' }, 'python 路径'),
            TextInput({ value: cfg.pythonPath, placeholder: '留空 = PATH 里的 python', mono: true, onCommit: (v) => patch({ pythonPath: v }, 'python 路径') }),
            h('div', { 'data-br-hint': '' }, '提示：Windows 上 PATH 里的 python 可能是应用商店的别名（跑不起来），建议填完整的 python.exe 路径。')) : null),

        // ── 操作 ──
        h('div', { 'data-br-sec': '' },
          h('div', { 'data-br-btns': '' },
            Btn({ children: '立即检查一次', onClick: onCheck, disabled: busy === 'check', primary: true }),
            Btn({ children: '测试登录', onClick: onTest, disabled: busy === 'test' })),
          h('div', { 'data-br-hint': '' }, '「立即检查」不会等定时器，马上跑一轮；日志在下面刷新。')),

        // ── 日志 ──
        h('div', { 'data-br-sec': '' },
          h('div', { 'data-br-h': '' }, '运行日志（最近 30 行）'),
          h('pre', { 'data-br-pre': '' }, (cfg.log && cfg.log.length ? cfg.log : ['（还没有日志）']).join('\n'))),

        // ── 最近回复 ──
        h('div', { 'data-br-sec': '' },
          h('div', { 'data-br-h': '' }, '最近回复'),
          (cfg.replies && cfg.replies.length
            ? cfg.replies.slice().reverse().map((r, i) => h('div', { key: i, 'data-br-row': '' },
              h('div', { 'data-br-grow': '' },
                h('div', { 'data-br-label': '', style: { fontSize: '12px' } }, r.title || '（无标题）'),
                h('div', { 'data-br-note': '' }, r.text || '')),
              Tag({ text: r.anon ? '匿名可见' : '待审核', tone: r.anon ? 'good' : 'warn' })))
            : h('div', { 'data-br-note': '' }, '还没发过回复'))),

        // ── 被 @ 与回复记录（按需查看最近 1 天） ──
        h('div', { 'data-br-sec': '' },
          h('div', { 'data-br-row': '' },
            h('div', { 'data-br-grow': '' },
              h('div', { 'data-br-h': '' }, '被 @ 与回复记录'),
              h('div', { 'data-br-note': '' }, '不常驻刷新；点按钮才拉取最近 1 天的记录（谁 @ 的、@ 原文、回了什么、状态）')),
            Btn({ children: recBusy ? '读取中…' : '查看最近 1 天', onClick: onLoadRecords, disabled: recBusy, primary: true })),
          records === null
            ? null
            : (records.length === 0
              ? h('div', { 'data-br-note': '' }, '最近 1 天没有记录')
              : h('div', { 'data-br-records': '' },
                records.slice().reverse().map((r, i) => h('div', { key: i, 'data-br-rec': '' },
                  h('div', { 'data-br-grow': '' },
                    h('div', { 'data-br-label': '', style: { fontSize: '12px' } }, `${fmtAt(r)}  ${r.title || '（无标题）'}`),
                    h('div', { 'data-br-note': '' }, `@ 原文：${r.text || '（空）'}`),
                    r.reply ? h('div', { 'data-br-note': '' }, `回复：${r.reply}`) : h('div', { 'data-br-note': '' }, `结果：${r.msg || '（没回）'}`)),
                  Tag({
                    text: r.ok ? (r.anon ? '已回复·可见' : '已回复·待审核') : (r.skipped ? '跳过' : '失败'),
                    tone: r.ok ? 'good' : 'warn',
                  })))))),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-reply')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-reply: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-reply', order: 40, label: 'B站自动回复' },
          () => h(Panel),
        ))
      },
    }
  },
})
