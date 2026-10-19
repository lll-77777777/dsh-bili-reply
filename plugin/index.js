/**
 * dsh-bili-reply —— B站「@我的」自动回复看门狗（插件版 · 带可视化设置页）
 * ============================================================================
 * 它是什么：把原来那套 PowerShell 看门狗（watch-at-http.ps1）搬进 DSH 插件里：
 *   1. **纯 HTTP** 轮询 B站「@我的」通知（cookie 直填，不碰浏览器）；
 *   2. 白名单：只回「主人 UID @ 我」的那条，其它通知只看不处理；
 *   3. 视频类：评论里**明确要求**（总结/讲什么/时间点…）才调 video-watch 做本地转写；
 *      再把文字稿交给 `dsh --profile headless` 写文案，纯 HTTP 发楼中楼；
 *   4. 发完带 cookie + 匿名各查一次可见性（`state=17` = 审核中）；
 *   5. **设置页**（client.js）通过 `/api/bili-reply/*` 读写配置、看状态、手动检查。
 *
 * 家目录（`$DSH_HOME/bili-reply/`）：
 *   config.json（设置页数据，cookie 存这里，不进插件包）
 *   state.json（cursor / seen / lastReplyAt / lastResult）
 *   reply.log（每次检查/回复一行，设置页显示 tail）
 *   replies.jsonl（每次真的发出去的评论）
 *   mentions.jsonl（被 @ 与回复记录：时间/@原文/回复内容/状态，设置页「查看最近 1 天」按需读取）
 *   prompt-last.txt（最后一次交给 headless 的提示词，方便排查）
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { stateDirOf, ensureDir, readJson, writeJson, appendLog, tail } from './lib/state.mjs'
import * as bili from './lib/bili.mjs'
import { transcribeVideo, defaultVideoWatchDir } from './lib/video.mjs'
import { generateReply } from './lib/ai.mjs'

export const name = 'bili-reply'
export const inject = ['webServer', 'settings']

// ⚠️ 每个字段都要 .extra('volatile', true)：DSH 的 settings.update() 只认 volatile 字段
export const Config = !z ? undefined : z.object({
  /** 总开关：打开才会自动轮询 */
  enabled: z.boolean().default(false).extra('volatile', true),
  /** 主人 UID（只回这个 UID 的 @） */
  ownerMid: z.natural().default(0).extra('volatile', true),
  /** 主人昵称（B站通知主要靠昵称认人；和 UID 一起做双保险，任一匹配就算主人） */
  ownerName: z.string().default('').extra('volatile', true),
  /** 回复所有人：任何人的「@我」都回复（默认只回主人的） */
  replyAll: z.boolean().default(false).extra('volatile', true),
  /** 也回复「回复我的」：别人回复我发的评论时也回（默认关闭） */
  watchReplies: z.boolean().default(false).extra('volatile', true),
  /** 每个时间窗口内最多回复多少条（0 = 不限） */
  maxReplies: z.natural().default(0).extra('volatile', true),
  /** 「最多回复条数」的时间窗口是多少分钟（默认 60 分钟 = 每小时） */
  maxRepliesWindowMin: z.natural().default(60).extra('volatile', true),
  /** 发完一条评论后最少隔几分钟再发下一条 */
  rateLimitMin: z.natural().default(3).extra('volatile', true),
  /** 视频超过多少分钟就不看（0 = 不限） */
  maxVideoMin: z.natural().default(60).extra('volatile', true),
  /** 每轮检查完 30 秒再补查一次（防止两轮之间来的 @ 要等 1 分钟） */
  secondPass: z.boolean().default(true).extra('volatile', true),
  /** 只看模式：发现 @ 只写日志，不自动回复 */
  noReply: z.boolean().default(false).extra('volatile', true),
  /** 浏览器 Cookie 头（F12 → Network → 任意请求 → Cookie，整段粘贴） */
  cookie: z.string().default('').extra('volatile', true),
  /** dsh 命令（写评论文案用 headless profile），留空 = 用 PATH 里的 dsh */
  dshBin: z.string().default('').extra('volatile', true),
  /** 生成文案用的 profile */
  headlessProfile: z.string().default('headless').extra('volatile', true),
  /** video-watch 技能目录，留空 = $DSH_HOME/skills/video-watch */
  videoWatchDir: z.string().default('').extra('volatile', true),
  /** python 解释器完整路径（Windows 上 PATH 里的 python 可能是别名） */
  pythonPath: z.string().default('').extra('volatile', true),
  /** 回复文案最多多少字 */
  replyChars: z.natural().default(120).extra('volatile', true),
  /** 转写文字稿最多喂给模型多少字 */
  transcriptMax: z.natural().default(8000).extra('volatile', true),
  /** 人设文件（.md）：让回复按这个人设说话；留空 = 用内置默认人设 */
  personaFile: z.string().default('').extra('volatile', true),
  /** 私信回复：打开后收到私信就自动回（默认关闭） */
  imReply: z.boolean().default(false).extra('volatile', true),
  /** 私信只回主人（关掉 = 谁私信都回，谨慎开） */
  imOwnerOnly: z.boolean().default(true).extra('volatile', true),
})

const DEFAULTS = {
  enabled: false,
  ownerMid: 0,
  ownerName: '',
  replyAll: false,
  watchReplies: false,
  maxReplies: 0,
  maxRepliesWindowMin: 60,
  rateLimitMin: 3,
  maxVideoMin: 60,
  secondPass: true,
  noReply: false,
  cookie: '',
  dshBin: '',
  headlessProfile: 'headless',
  videoWatchDir: '',
  pythonPath: '',
  replyChars: 120,
  transcriptMax: 8000,
  personaFile: '',
  imReply: false,
  imOwnerOnly: true,
}

const NUM_KEYS = ['ownerMid', 'maxReplies', 'maxRepliesWindowMin', 'rateLimitMin', 'maxVideoMin', 'replyChars', 'transcriptMax']
const BOOL_KEYS = ['enabled', 'replyAll', 'watchReplies', 'secondPass', 'noReply', 'imReply', 'imOwnerOnly']
const STR_KEYS = ['cookie', 'dshBin', 'headlessProfile', 'videoWatchDir', 'pythonPath', 'personaFile', 'ownerName']

function iso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function normalizeConfig(src, base) {
  const out = { ...(base || DEFAULTS) }
  if (!src || typeof src !== 'object') return out
  for (const k of STR_KEYS) if (typeof src[k] === 'string') out[k] = src[k]
  for (const k of NUM_KEYS) {
    const n = Number(src[k])
    if (Number.isFinite(n) && n >= 0) out[k] = Math.floor(n)
  }
  for (const k of BOOL_KEYS) if (typeof src[k] === 'boolean') out[k] = src[k]
  return out
}

/** Cookie 头 → 字段表；只粘一个值（SESSDATA）也认 */
function parseCookie(text) {
  const out = {}
  const s = String(text || '').trim()
  if (!s) return out
  if (!s.includes('=')) {
    if (s.length > 60 && s.includes('%')) out.SESSDATA = s
    return out
  }
  for (const part of s.split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/** SESSDATA 里第二段是过期时间戳（秒） */
function cookieDaysLeft(cookieText) {
  const ck = parseCookie(cookieText)
  if (!ck.SESSDATA) return null
  try {
    const decoded = decodeURIComponent(ck.SESSDATA)
    const parts = decoded.split(',')
    const exp = Number(parts[1])
    if (!Number.isFinite(exp) || exp <= 0) return null
    return Math.max(0, Math.ceil((exp * 1000 - Date.now()) / 86400000))
  } catch {
    return null
  }
}

/** 读人设文件（.md）。留空或读不到 = 用内置默认人设 */
function readPersona(file) {
  if (!file) return ''
  try {
    const txt = readFileSync(String(file), 'utf8').trim()
    if (!txt) return ''
    return txt.length > 4000 ? txt.slice(0, 4000) + '\n…（人设太长，已截断）' : txt
  } catch {
    return ''
  }
}

/** 提示词：把「这条 @ 是什么 + 文字稿 + 说话要求」交给 headless */
function buildPrompt(cfg, item, transcript) {
  const lines = []
  lines.push('你是一只被 B 站用户 @ 的「大肥鱼」助手，要替主人回一条评论（楼中楼）。')
  if (item.isOwner) {
    lines.push('说话第一人称、口语化，可以亲昵地叫对方「主人」，但别油腻、别表演。')
  } else {
    lines.push('说话第一人称、口语化；对方不是主人，是个普通 B 站用户——绝对不能叫对方「主人」，用「你」称呼即可，别油腻、别表演。')
  }
  const persona = readPersona(cfg.personaFile)
  if (persona) {
    lines.push('')
    lines.push('## 人设（必须遵守：说话身份、称呼、语气都按这个人设来）')
    lines.push(persona)
    lines.push('以上人设是最高优先级；但这条是 B 站评论回复，要短、别刷屏。')
  }
  lines.push('')
  lines.push('## 这条 @ 是什么')
  lines.push(`- 标题：${item.title || '（无标题）'}`)
  lines.push(`- 链接：${item.uri || '（无）'}`)
  lines.push(`- @ 原文：${item.text || '（空）'}`)
  lines.push('')
  if (transcript) {
    lines.push('## 视频文字稿（带 [MM:SS] 时间戳，来自本地转写）')
    lines.push(transcript)
    lines.push('')
    if (item.src === 'at' && item.isOwner) {
      lines.push('如果文字稿里有值得展开的内容，挑 2~4 个真实时间点写成「MM:SS 一句话」，时间戳必须来自上面的文字稿，不许编造。')
    } else if (item.src === 'reply') {
      lines.push('这条是「别人回复我的评论」——闲聊接话，**不要引用视频时间点、不要写 MM:SS**；文字稿只用来了解上下文，回复要短、自然接话。')
    } else {
      lines.push('这条是其他人的 @（不是主人）——闲聊接话就行，**不要引用视频时间点、不要写 MM:SS**；文字稿只用来了解上下文，回复要短、自然。')
    }
  } else {
    lines.push(item.src === 'reply'
      ? '这条是「别人回复我的评论」（不是视频 @），根据对方的话写一句自然、有梗的接话，别端着。'
      : '这条 @ 不是视频（没有文字稿），就根据标题和 @ 原文写一句自然、有梗、别端着的话。')
  }
  lines.push('')
  lines.push('## 要求')
  lines.push('- 只输出评论正文本身：不要前缀、不要引号、不要代码块、不要任何解释。')
  lines.push(`- 长度不超过 ${cfg.replyChars} 字，短句为主，读起来像真人说话。`)
  lines.push('- 不要提「我是 AI」「根据文字稿」这类词；不要说空话套话。')
  lines.push('- 结尾可以带一点点小情绪，但不要油腻。')
  return lines.join('\n')
}

/** 私信提示词：人设 + 最近对话 + 这条新消息 */
function buildIMPrompt(cfg, talker, history, text) {
  const lines = []
  lines.push('你是「大肥鱼」助手，正在和主人用 B 站私信聊天。')
  lines.push('说话第一人称、口语化、短句为主；可以亲昵地叫对方「主人」，但别油腻、别表演。')
  const persona = readPersona(cfg.personaFile)
  if (persona) {
    lines.push('')
    lines.push('## 人设（最高优先级：说话身份、称呼、语气都按这个人设来）')
    lines.push(persona)
  }
  lines.push('')
  lines.push('## 最近的对话（旧 → 新）')
  if (history.length) {
    for (const m of history) {
      const who = Number(m.senderUid) === Number(talker) ? '主人' : '我'
      lines.push(`${who}：${String(m.text || '').replace(/\n/g, ' ').slice(0, 120)}`)
    }
  } else {
    lines.push('（还没有更早的对话，这是第一条）')
  }
  lines.push('')
  lines.push('## 主人刚发来的新消息')
  lines.push(String(text || '').slice(0, 300))
  lines.push('')
  lines.push('## 要求')
  lines.push('- 只输出回复正文本身：不要前缀、不要引号、不要代码块、不要任何解释。')
  lines.push(`- 不超过 ${cfg.replyChars} 字，像真人发私信那样短。`)
  lines.push('- 接住对方的话头，别答非所问；不要提「我是 AI」「文字稿」这类词。')
  return lines.join('\n')
}

export function apply(ctx, config) {
  const stateDir = ensureDir(stateDirOf())
  const configFile = join(stateDir, 'config.json')
  const stateFile = join(stateDir, 'state.json')
  const logFile = join(stateDir, 'reply.log')
  const repliesFile = join(stateDir, 'replies.jsonl')
  const mentionsFile = join(stateDir, 'mentions.jsonl')
  const promptFile = join(stateDir, 'prompt-last.txt')

  // 文件里的值优先（设置页保存过），没有才用 Config 默认
  const fileCfg = readJson(configFile, {})
  const cfg = normalizeConfig({ ...normalizeConfig(config || {}), ...fileCfg })
  const state = Object.assign(
    { cursor: 0, replyCursor: 0, seen: [], lastReplyAt: 0, lastCheck: '', lastResult: '', accountName: '', replyTimes: [], syncedCookieHash: '', imSeen: [], imLastResult: '' },
    readJson(stateFile, {}),
  )
  if (!Array.isArray(state.replyTimes)) state.replyTimes = []
  if (!Array.isArray(state.imSeen)) state.imSeen = []

  const log = (line) => appendLog(logFile, line)
  const recordMention = (obj) => {
    try { appendFileSync(mentionsFile, JSON.stringify(obj) + '\n', 'utf8') } catch { /* 记录失败不影响主流程 */ }
  }
  const saveState = () => writeJson(stateFile, state)
  const saveCfg = () => writeJson(configFile, cfg)

  // ---------- 凭证单向同步：bili-reply 是真源，刷B站（dsh-bili-scroll）跟着走 ----------
  // 两个插件各存一份 B 站凭证，以前会各自过期、各换一次。现在这里（设置页 / cookie 保存）
  // 是唯一入口：插件加载 + cookie 变更时，把 SESSDATA / bili_jct / buvid3 / DedeUserID
  // 写进 $DSH_HOME/bili-duty/bili_credential.json。用 cookie 哈希防回冲 —— bili-reply 的
  // cookie 没变就不写，免得把刷B站那边扫码换来的新凭证又盖回去。刷B站没装就静默跳过。
  const biliDutyCredFile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty', 'bili_credential.json')
  const cookieHash = (s) => {
    try { return createHash('sha1').update(String(s || '')).digest('hex') } catch { return '' }
  }
  const syncCredentialToDuty = (reason = '') => {
    try {
      const ck = parseCookie(cfg.cookie)
      if (!ck.SESSDATA || !ck.bili_jct || !ck.DedeUserID) return false
      if (!existsSync(dirname(biliDutyCredFile))) return false
      const h = cookieHash(cfg.cookie)
      if (String(state.syncedCookieHash || '') === h) return true
      writeJson(biliDutyCredFile, {
        sessdata: ck.SESSDATA,
        bili_jct: ck.bili_jct,
        buvid3: ck.buvid3 || '',
        dedeuserid: String(ck.DedeUserID),
      })
      state.syncedCookieHash = h
      saveState()
      log(`凭证已同步给刷B站（${reason || '自动'}，账号 ${ck.DedeUserID}）`)
      return true
    } catch (e) {
      log(`凭证同步给刷B站失败：${e?.message || e}`)
      return false
    }
  }
  syncCredentialToDuty('插件启动')

  let running = false
  let mainTimer = null
  let secondTimer = null
  let accountCache = { at: 0, name: '' }

  // ---------- 设置页（原生设置里也有一项） ----------
  try {
    if (typeof ctx.settings?.register === 'function') {
      ctx.settings.register('bili-reply', Config, { base: {}, applies: 'live' })
    }
  } catch (e) {
    log(`设置页注册失败：${e?.message || e}`)
  }

  // ---------- 账号信息（cookie 变了才刷新） ----------
  async function selfAccount(ck, force = false) {
    if (!force && accountCache.name && Date.now() - accountCache.at < 5 * 60 * 1000) return accountCache
    const nav = await bili.nav(ck)
    if (nav.ok) accountCache = { at: Date.now(), name: nav.uname || '', mid: Number(nav.mid || 0) || 0 }
    return accountCache
  }

  /** 评论里有没有「明确要求看视频内容」的指示；没有就只看标题闲聊，不转写 */
  function shouldTranscribe(text) {
    const t = String(text || '')
    if (!t) return false
    return /(总结|概括|归纳|讲(了)?(什么|啥)|说(了)?(什么|啥|些什么)|内容|转写|文字稿|时间点|时间戳|几分几秒|[0-9]{1,2}:[0-9]{2}|哪(一)?句|详细(说|讲|介绍)|分析(一下)?这|评价(一下)?这|这(期|个视频)(讲|说))/.test(t)
  }

  // ---------- 主流程 ----------
  function rateLimited() {
    return cfg.rateLimitMin > 0 && Date.now() - Number(state.lastReplyAt || 0) < cfg.rateLimitMin * 60000
  }

  /** 时间窗内「最多回复几条」：达到上限时返回 {max, win, waitMin}，否则 null */
  function replyCountWindow() {
    const max = Math.max(0, Number(cfg.maxReplies) || 0)
    if (!max) return null
    const win = Math.max(1, Number(cfg.maxRepliesWindowMin) || 60)
    const since = Date.now() - win * 60000
    const recent = state.replyTimes.map(Number).filter((t) => t > since)
    if (recent.length < max) return null
    const oldest = Math.min(...recent)
    const waitMin = Math.max(1, Math.ceil((oldest + win * 60000 - Date.now()) / 60000))
    return { max, win, waitMin, recent: recent.length }
  }

  async function replyTo(item) {
    const ck = parseCookie(cfg.cookie)
    log(`开始处理：${item.title || item.uri}`)
    // 1) 身份复核（确认这条 @ 真是主人的评论）
    const verify = await bili.verifyComment(ck, item)
    if (!verify.ok) {
      log(`身份复核失败：${verify.msg}`)
      return { ok: false, msg: `身份复核失败：${verify.msg}` }
    }
    const target = { ...item }
    // 楼中楼：item.root 是被回复的那条评论，真正根评论是 verify.root
    // @ 通知：parent = 被 @ 的评论（item.root）；「回复我的」：parent = 对方的回复（item.rpid）
    target.parent = String(item.rpid || item.root || '')
    target.root = String(verify.root || item.root || '')
    // 2) 视频：默认不转写——多数 @ 都是闲聊，转写要把整段视频下下来，慢且容易失败。
    //    只有评论里明确要求看内容（总结/讲什么/时间点…）才转写；失败也不跳过整条回复。
    const wantTranscript = shouldTranscribe(item.text || '')
    let transcript = ''
    if (item.bvid && wantTranscript) {
      const vi = await bili.videoInfo(ck, item.uri)
      if (vi.ok) {
        const durMin = vi.duration / 60
        if (cfg.maxVideoMin > 0 && durMin > cfg.maxVideoMin) {
          const msg = `视频 ${Math.round(durMin)} 分钟，超过上限 ${cfg.maxVideoMin} 分钟，跳过`
          log(msg)
          return { ok: false, skipped: true, msg }
        }
        log(`转写视频（${Math.round(vi.duration)} 秒）…`)
        const tr = await transcribeVideo({
          python: cfg.pythonPath,
          watchDir: cfg.videoWatchDir || defaultVideoWatchDir(),
          url: item.uri,
          maxTranscript: cfg.transcriptMax,
        })
        if (!tr.ok) {
          log(`取文字稿失败：${tr.msg}`)
          return { ok: false, msg: `取文字稿失败：${tr.msg}` }
        }
        transcript = tr.transcript
        log(`转写完成（${transcript.length} 字）`)
      } else {
        log(`取视频信息失败：${vi.msg}`)
      }
    }
    // 3) 写文案
    writeFileSync(promptFile, buildPrompt(cfg, item, transcript), 'utf8')
    log('写评论…')
    const gen = await generateReply({
      dshBin: cfg.dshBin || 'dsh',
      profile: cfg.headlessProfile,
      taskFile: promptFile,
    })
    if (!gen.ok) {
      log(`写评论失败：${gen.msg}`)
      return { ok: false, msg: `写评论失败：${gen.msg}` }
    }
    // 4) 发评论
    log('发评论…')
    const sent = await bili.sendReply(ck, target, gen.text)
    if (!sent.ok) {
      log(`发评论失败：${sent.msg}`)
      return { ok: false, msg: `发评论失败：${sent.msg}` }
    }
    // 5) 复查可见性
    const vis = await bili.checkVisible(ck, target, sent.rpid)
    try {
      writeFileSync(repliesFile, `${JSON.stringify({ t: iso(), rpid: sent.rpid, oid: String(item.oid), title: item.title || '', text: gen.text, anon: !!vis.anon, self: !!vis.self })}\n`, { flag: 'a' })
    } catch { /* 记录失败不影响主流程 */ }
    const note = vis.anon ? '匿名可见 ✓' : '已发出但匿名不可见（可能还在审核中）'
    log(`回复成功 rpid=${sent.rpid}，${note}`)
    return { ok: true, rpid: sent.rpid, anon: !!vis.anon, text: gen.text }
  }

  async function doCheck() {
    if (!cfg.cookie) {
      state.lastResult = '没配 cookie'
      return
    }
    const ck = parseCookie(cfg.cookie)
    if (!ck.SESSDATA) {
      state.lastResult = 'cookie 里没有 SESSDATA'
      log('检查跳过：cookie 里没有 SESSDATA')
      return
    }
    const feed = await bili.atFeed(ck)
    if (!feed.ok) {
      state.lastResult = `检查失败：${feed.msg}`
      log(`检查失败：${feed.msg}`)
      return
    }
    const acc = await selfAccount(ck)
    const selfMid = Number(ck.DedeUserID || acc.mid || 0)
    if (acc.name) state.accountName = acc.name
    const cursor = Number(state.cursor || 0)
    const replyCursor = Number(state.replyCursor || 0)
    const fresh = feed.items.filter((i) => Number(i.atTime) > cursor && !state.seen.includes(String(i.id)))
    // 「回复我的」（默认关闭）：别人回复我发的评论
    let replyFresh = []
    if (cfg.watchReplies) {
      const rf = await bili.replyFeed(ck)
      if (rf.ok) {
        replyFresh = rf.items.filter((i) => Number(i.atTime) > replyCursor && !state.seen.includes(String(i.id)))
      } else {
        log(`检查「回复我的」失败：${rf.msg}`)
      }
    }
    if (!fresh.length && !replyFresh.length) {
      state.lastResult = '无新 @'
      log(`无新 @（cursor=${state.cursor}${cfg.watchReplies ? `，回复我的 cursor=${state.replyCursor || 0}` : ''}）`)
      return
    }
    const ownerMid = Number(cfg.ownerMid)
    const ownerName = String(cfg.ownerName || '').trim()
    // 双保险：UID 命中或昵称命中，任一匹配就算主人
    const isOwnerAt = (i) => Number(i.mid) === ownerMid || (!!ownerName && String(i.name || '').trim() === ownerName)
    const atMine = fresh.filter((i) => (cfg.replyAll || isOwnerAt(i)) && (i.ats || []).includes(selfMid))
    // 队列顺序：主人 @ → 回复我的 → 其他人的 @
    const queue = [
      ...atMine.filter(isOwnerAt).map((i) => ({ ...i, src: 'at' })),
      ...replyFresh.map((i) => ({ ...i, src: 'reply' })),
      ...atMine.filter((i) => !isOwnerAt(i)).map((i) => ({ ...i, src: 'at' })),
    ]
    log(`发现 ${fresh.length} 条新 @、${replyFresh.length} 条回复我的，可回 ${queue.length} 条（${cfg.replyAll ? '回复所有人' : '只回主人'}${cfg.watchReplies ? '，含回复我的' : ''}）`)
    if (!queue.length) {
      // 没有可回的：只推进游标，不回复
      if (fresh.length) {
        state.cursor = Math.max(cursor, ...fresh.map((i) => Number(i.atTime)))
        state.seen.push(...fresh.map((i) => String(i.id)))
      }
      if (replyFresh.length) {
        state.replyCursor = Math.max(replyCursor, ...replyFresh.map((i) => Number(i.atTime)))
        state.seen.push(...replyFresh.map((i) => String(i.id)))
      }
      state.lastResult = cfg.replyAll ? '有新通知，但没有可回的' : '有新通知，但不是主人的 @'
      return
    }
    const item = queue[0]
    const isOwnerItem = isOwnerAt(item)
    item.isOwner = isOwnerItem
    if (cfg.noReply) {
      const who = isOwnerItem ? '主人 @' : (item.src === 'reply' ? '回复我的' : '其他人的 @')
      state.lastResult = `发现${who}（只看模式）：${item.title || item.uri}`
      log(`只看模式：不自动回复（${who}：${item.title || item.uri}）`)
      recordMention({
        t: iso(), id: String(item.id), atTime: Number(item.atTime) || 0,
        title: item.title || '', url: item.uri || '', text: item.text || '',
        biz: item.biz, ok: false, skipped: true, anon: false, rpid: '',
        reply: '', msg: '只看模式，没回复',
      })
      if (item.src === 'reply') state.replyCursor = Math.max(replyCursor, Number(item.atTime) || 0)
      else state.cursor = Math.max(cursor, Number(item.atTime) || 0)
      state.seen.push(String(item.id))
      return
    }
    // 限流只约束「回复所有人」里的其他人；主人的 @ 永远优先、不受限
    if (!isOwnerItem) {
      if (rateLimited()) {
        const wait = Math.ceil((cfg.rateLimitMin * 60000 - (Date.now() - Number(state.lastReplyAt || 0))) / 60000)
        state.lastResult = `限速中（约 ${wait} 分钟后可回）`
        log(`限速中：约 ${wait} 分钟后可回下一条（这条不是主人的 @）`)
        return // 不改 cursor / 不 seen，下一轮重来
      }
      const winLimit = replyCountWindow()
      if (winLimit) {
        state.lastResult = `已达回复上限（${winLimit.win} 分钟内最多 ${winLimit.max} 条，约 ${winLimit.waitMin} 分钟后再试）`
        log(`已达回复上限：${winLimit.win} 分钟内最多 ${winLimit.max} 条，约 ${winLimit.waitMin} 分钟后再试（这条不是主人的 @）`)
        return // 不改 cursor / 不 seen，下一轮重来
      }
    }
    const r = await replyTo(item)
    // 记一条「被 @ 与回复内容」，设置页按需查最近 1 天
    recordMention({
      t: iso(), id: String(item.id), atTime: Number(item.atTime) || 0,
      title: item.title || '', url: item.uri || '', text: item.text || '',
      biz: item.biz, ok: !!r.ok, skipped: !!r.skipped, anon: !!r.anon,
      rpid: r.rpid || '', reply: r.text || '', msg: r.ok ? '' : (r.msg || ''),
    })
    // 处理完（无论成败）只推进到「刚处理的那条」为止；同源里更早的未处理条目不能被跳过
    const doneT = Number(item.atTime) || 0
    const srcItems = item.src === 'reply' ? replyFresh : fresh
    const earlier = srcItems.filter((i) => String(i.id) !== String(item.id) && (Number(i.atTime) || 0) <= doneT)
    const advanceTo = earlier.length ? Math.min(doneT, Math.min(...earlier.map((i) => Number(i.atTime))) - 1) : doneT
    if (item.src === 'reply') state.replyCursor = Math.max(replyCursor, advanceTo)
    else state.cursor = Math.max(cursor, advanceTo)
    state.seen.push(String(item.id))
    if (r.ok) {
      state.lastReplyAt = Date.now()
      // 只有「回复其他人」才计入「每 N 分钟最多 M 条」的窗口；主人的 @ 不计入、不受限
      if (!isOwnerItem) {
        const keepMs = 7 * 24 * 3600 * 1000
        state.replyTimes = state.replyTimes.map(Number).filter((t) => Date.now() - t < keepMs).slice(-500)
        state.replyTimes.push(state.lastReplyAt)
      }
      state.lastResult = `回复成功 rpid=${r.rpid}${r.anon ? '（匿名可见）' : '（等待审核）'}`
    } else if (r.skipped) {
      state.lastResult = `跳过：${r.msg}`
    } else {
      state.lastResult = `失败：${r.msg}`
    }
    if (state.seen.length > 200) state.seen = state.seen.slice(-200)
  }

  /** 私信回复：找未处理的新私信 → headless 写文案 → 回过去 */
  async function doIMCheck() {
    if (!cfg.imReply) return
    if (!cfg.cookie) return
    const ck = parseCookie(cfg.cookie)
    if (!ck.SESSDATA || !ck.DedeUserID) return
    const selfMid = Number(ck.DedeUserID || 0)
    const ss = await bili.imSessions(ck)
    if (!ss.ok) {
      state.imLastResult = `私信列表拉取失败：${ss.msg}`
      log(`私信列表拉取失败：${ss.msg}`)
      return
    }
    const ownerMid = Number(cfg.ownerMid)
    const candidates = ss.list.filter((s) => {
      if (!s.last || !s.last.text) return false
      if (s.talkerId === selfMid || s.last.senderUid === selfMid) return false // 最后一条是自己发的 = 没新消息
      if (cfg.imOwnerOnly) return ownerMid > 0 && s.talkerId === ownerMid
      return true
    })
    const s = candidates[0]
    if (!s) {
      state.imLastResult = '没有新私信'
      return
    }
    const last = s.last
    if (state.imSeen.includes(last.msgKey)) {
      state.imLastResult = '没有新私信'
      return
    }
    // 关注自动问候之类的系统消息：不回复
    if (last.text.length < 50 && /开始聊天吧|互相关注|欢迎关注|感谢关注/.test(last.text)) {
      state.imSeen.push(last.msgKey)
      state.imSeen = state.imSeen.slice(-500)
      state.imLastResult = '忽略系统自动消息'
      log(`忽略系统私信：${last.text.slice(0, 30)}`)
      return
    }
    // 拉上下文（新→旧），反转成旧→新
    const mm = await bili.imMessages(ck, s.talkerId, { size: 20 })
    const history = mm.ok ? mm.list.slice().reverse() : []
    writeFileSync(promptFile, buildIMPrompt(cfg, s.talkerId, history, last.text), 'utf8')
    log(`私信：${s.talkerId} 发来「${last.text.slice(0, 30).replace(/\n/g, ' ')}」，写回复…`)
    const gen = await generateReply({
      dshBin: cfg.dshBin || 'dsh',
      profile: cfg.headlessProfile,
      taskFile: promptFile,
    })
    state.imSeen.push(last.msgKey)
    state.imSeen = state.imSeen.slice(-500)
    if (!gen.ok) {
      state.imLastResult = `私信写文案失败：${gen.msg}`
      log(`私信写文案失败：${gen.msg}`)
      return
    }
    const sent = await bili.sendIM(ck, s.talkerId, gen.text, { senderUid: selfMid })
    if (!sent.ok) {
      state.imLastResult = `私信发送失败：${sent.msg}`
      log(`私信发送失败：${sent.msg}`)
      return
    }
    state.imLastResult = `已回私信给 ${s.talkerId}`
    log(`私信已发送 msgKey=${sent.msgKey}`)
  }

  async function tick() {
    if (running) {
      log('检查跳过：上一轮还在跑')
      return
    }
    if (!cfg.enabled) {
      state.lastResult = '已关闭'
      return
    }
    // 一次性补漏（2026-10-19）：早期版本打开「回复我的」时把游标跳到当下，漏掉了开启前的回复。
    // 这里把游标回拨到 10-17 08:00 之前，并把同批「更早就该跳过」的三条标记为已读，只补回真正漏掉的那条。
    // 迁移只做一次（state.migReply20261019 标记）。
    if (!state.migReply20261019 && Number(state.replyCursor || 0) > 1792190000) {
      state.replyCursor = 1792190000
      state.seen = Array.isArray(state.seen) ? state.seen : []
      for (const x of ['1181962148749313', '1181751343177732', '1181670929981442']) {
        if (!state.seen.includes(x)) state.seen.push(x)
      }
      state.migReply20261019 = true
      saveState()
      log(`一次性迁移：replyCursor 回拨到 ${state.replyCursor}，补回开启前漏掉的回复`)
    }
    running = true
    state.lastCheck = iso()
    try {
      await doCheck()
      await doIMCheck()
    } catch (e) {
      state.lastResult = `检查异常：${e?.message || e}`
      log(`检查异常：${e?.message || e}`)
    } finally {
      running = false
      saveState()
    }
  }

  // ---------- 定时器：每分钟一轮，可选的 30 秒补检 ----------
  function schedule() {
    clearTimeout(mainTimer)
    mainTimer = setTimeout(async () => {
      await tick()
      if (cfg.enabled && cfg.secondPass) {
        clearTimeout(secondTimer)
        secondTimer = setTimeout(() => { if (!running) void tick() }, 30000)
      }
      schedule()
    }, 60000)
  }

  ctx.effect(() => () => { clearTimeout(mainTimer); clearTimeout(secondTimer) }, 'bili-reply: 停定时器')
  // 启动后 8 秒先跑一轮（等宿主起来），之后每分钟
  clearTimeout(mainTimer)
  mainTimer = setTimeout(async () => { await tick(); schedule() }, 8000)

  // ---------- HTTP 路由（设置页用） ----------
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
  const tailLines = (n) => {
    const t = tail(logFile, n)
    return t ? t.split('\n') : []
  }
  const repliesTail = (n) => {
    try {
      const lines = readFileSync(repliesFile, 'utf8').split(/\r?\n/).filter(Boolean)
      return lines.slice(-n).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { return [] }
  }

  function status() {
    const ck = parseCookie(cfg.cookie)
    const days = cookieDaysLeft(cfg.cookie)
    const windowMs = Math.max(1, Number(cfg.maxRepliesWindowMin) || 60) * 60000
    const nowTs = Date.now()
    const timesInWindow = state.replyTimes.map(Number).filter((t) => nowTs - t < windowMs).sort((a, b) => a - b)
    const quotaLimit = Number(cfg.maxReplies || 0)
    const quotaLeft = quotaLimit > 0 ? Math.max(0, quotaLimit - timesInWindow.length) : null
    const nextQuotaAt = quotaLimit > 0 && timesInWindow.length >= quotaLimit
      ? iso(new Date(timesInWindow[0] + windowMs))
      : ''
    return {
      ok: true,
      version: '0.1.0',
      home: stateDir,
      enabled: !!cfg.enabled,
      secondPass: !!cfg.secondPass,
      noReply: !!cfg.noReply,
      cookieOk: !!ck.SESSDATA,
      cookieJct: !!ck.bili_jct,
      cookieDaysLeft: days,
      selfMid: Number(ck.DedeUserID || accountCache.mid || 0) || 0,
      accountName: state.accountName || accountCache.name || '',
      ownerMid: cfg.ownerMid,
      ownerName: cfg.ownerName || '',
      replyAll: !!cfg.replyAll,
      watchReplies: !!cfg.watchReplies,
      maxReplies: cfg.maxReplies,
      maxRepliesWindowMin: cfg.maxRepliesWindowMin,
      rateLimitMin: cfg.rateLimitMin,
      repliesInWindow: timesInWindow.length,
      quotaLimit,
      quotaLeft,
      nextQuotaAt,
      maxVideoMin: cfg.maxVideoMin,
      personaFile: cfg.personaFile,
      cursor: Number(state.cursor || 0),
      replyCursor: Number(state.replyCursor || 0),
      seenCount: Array.isArray(state.seen) ? state.seen.length : 0,
      imReply: !!cfg.imReply,
      imOwnerOnly: !!cfg.imOwnerOnly,
      imSeenCount: Array.isArray(state.imSeen) ? state.imSeen.length : 0,
      imLastResult: state.imLastResult || '',
      lastCheck: state.lastCheck || '',
      lastResult: state.lastResult || '',
      lastReplyAt: state.lastReplyAt ? iso(new Date(Number(state.lastReplyAt))) : '',
      running,
      log: tailLines(30),
      replies: repliesTail(10),
      promptFile,
    }
  }

  const handle = async (req, res, url) => {
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/bili-reply/status') return sendJson(res, 200, status())
    if (req.method === 'GET' && path === '/api/bili-reply/config') return sendJson(res, 200, { ok: true, config: cfg })
    if (req.method === 'POST' && path === '/api/bili-reply/config') {
      const body = await readBody(req)
      const wasWatchReplies = !!cfg.watchReplies
      const patch = normalizeConfig(body, cfg)
      Object.assign(cfg, patch)
      // 刚打开「回复我的」：从现在开始接，历史回复不补（避免一口气把旧评论全回一遍）
      if (!wasWatchReplies && cfg.watchReplies) {
        // 开启时回看 6 小时：避免「刚开启就漏掉开启前的回复」；更早的历史不补，防止一口气回一堆旧评论
        const graceFrom = Math.floor(Date.now() / 1000) - 6 * 3600
        state.replyCursor = Math.max(Number(state.replyCursor || 0), graceFrom)
        saveState()
        log(`「回复我的」已打开，从 6 小时前开始接（replyCursor=${state.replyCursor}）`)
      }
      saveCfg()
      if (body && body.cookieChanged) accountCache = { at: 0, name: '' }
      if (body && Object.prototype.hasOwnProperty.call(body, 'cookie')) syncCredentialToDuty('设置页更新')
      log('设置已保存')
      return sendJson(res, 200, { ok: true, config: cfg })
    }
    if (req.method === 'POST' && path === '/api/bili-reply/check') {
      if (!cfg.enabled) return sendJson(res, 200, { ok: false, error: '总开关没开（打开「自动回复」才会检查）' })
      if (running) return sendJson(res, 200, { ok: false, error: '上一轮还在跑' })
      void tick()
      return sendJson(res, 200, { ok: true, started: true })
    }
    if (req.method === 'POST' && path === '/api/bili-reply/save-cookie') {
      const body = await readBody(req)
      cfg.cookie = String(body.cookie || '')
      saveCfg()
      accountCache = { at: 0, name: '' }
      syncCredentialToDuty('设置页保存 cookie')
      log('cookie 已保存')
      return sendJson(res, 200, { ok: true, cookieDaysLeft: cookieDaysLeft(cfg.cookie) })
    }
    if (req.method === 'POST' && path === '/api/bili-reply/test') {
      const ck = parseCookie(cfg.cookie)
      if (!ck.SESSDATA) return sendJson(res, 200, { ok: false, error: '没配 cookie' })
      const nav = await bili.nav(ck)
      if (!nav.ok) return sendJson(res, 200, { ok: false, error: `登录态无效：${nav.msg}` })
      const key = ck.bili_jct ? 'cookie 直发可用' : '缺 bili_jct（发评论会 CSRF 失败）'
      return sendJson(res, 200, { ok: true, account: nav.uname, mid: nav.mid, note: key })
    }
    // 被 @ 与回复记录：按需读取最近 N 小时（默认 24 小时）
    if (req.method === 'GET' && path === '/api/bili-reply/records') {
      const rawHours = Number(url.searchParams.get('hours') || 24)
      const hours = Number.isFinite(rawHours) ? Math.max(1, Math.min(24 * 7, rawHours)) : 24
      const since = Date.now() - hours * 3600 * 1000
      let items = []
      try {
        items = readFileSync(mentionsFile, 'utf8').split(/\r?\n/).filter(Boolean)
          .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      } catch { /* 还没记录 */ }
      const inRange = items.filter((x) => {
        const sec = Number(x.atTime)
        const ts = sec > 1_000_000_000 ? sec * 1000 : (Date.parse(String(x.t || '').replace(' ', 'T')) || 0)
        return ts >= since
      })
      return sendJson(res, 200, { ok: true, hours, count: inRange.length, items: inRange.slice(-300) })
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-reply',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e) })
        }
      },
    }), 'bili-reply: /api/bili-reply 路由')
  } catch (e) {
    log(`HTTP 路由没挂上：${e?.message || e}`)
  }

  log(`插件已加载（家=${stateDir}，总开关=${cfg.enabled ? '开' : '关'}，主人=${cfg.ownerMid || '未设置'}${cfg.ownerName ? `「${cfg.ownerName}」` : ''}，范围=${cfg.replyAll ? '所有人' : '仅主人'}，回复我的=${cfg.watchReplies ? '开' : '关'}）`)

  // ---------- 启动后自检（5 秒后）：cookie 是否还有效、过期提醒 ----------
  let selfCheckTimer = null
  ctx.effect(() => () => { if (selfCheckTimer) clearTimeout(selfCheckTimer) }, 'bili-reply: 停启动自检')
  selfCheckTimer = setTimeout(async () => {
    try {
      if (!cfg.cookie) { log('启动自检：还没配 cookie'); return }
      const ck = parseCookie(cfg.cookie)
      if (!ck.SESSDATA) { log('启动自检：cookie 里没有 SESSDATA'); return }
      const days = cookieDaysLeft(cfg.cookie)
      const nav = await bili.nav(ck)
      if (!nav.ok) { log(`启动自检：登录态无效（${nav.msg}）——需要换 cookie`); return }
      state.accountName = nav.uname || state.accountName
      log(`启动自检：${nav.uname}（mid=${nav.mid}），SESSDATA 剩 ${days === null ? '?' : days} 天，总开关=${cfg.enabled ? '开' : '关'}`)
      if (days !== null && days <= 3) log(`启动自检：⚠️ SESSDATA 快过期（剩 ${days} 天），记得换 cookie`)
      saveState()
    } catch (e) {
      log(`启动自检异常：${e?.message || e}`)
    }
  }, 5000)
}
