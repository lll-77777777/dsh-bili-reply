/**
 * lib/bili.mjs —— B站 纯 HTTP 接口（at 通知 / 评论复核 / 发评论 / 匿名复查）
 * ============================================================================
 * 全部走 https://api.bilibili.com 的公开 Web 接口，带用户自己的 Cookie。
 * 不对接浏览器、不碰页面 DOM —— 插件后台每 30~60 秒调一次，必须轻。
 * ============================================================================
 */

import { createHash } from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const API = 'https://api.bilibili.com'
const IM_API = 'https://api.vc.bilibili.com'

/* ────────────── Cookie ────────────── */

export function parseCookie(str) {
  const out = {}
  for (const part of String(str || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = v
  }
  return out
}

export function cookieHeader(cookies) {
  return Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ')
}

/** SESSDATA 里第 2 段是过期时间（unix 秒） */
export function sessdataExpire(cookies) {
  const s = cookies?.SESSDATA
  if (!s) return null
  try {
    const dec = decodeURIComponent(String(s))
    const parts = dec.split(',')
    const n = Number(parts[1] || 0)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch { return null }
}

export function csrfOf(cookies) {
  return String(cookies?.bili_jct || '')
}

/* ────────────── 基础请求 ────────────── */

async function request(method, path, { cookies, body, anon } = {}) {
  const headers = { 'User-Agent': UA, Referer: REFERER }
  if (!anon) headers.Cookie = cookieHeader(cookies)
  let payload
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    payload = new URLSearchParams(body).toString()
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await fetch(/^https?:\/\//.test(path) ? path : API + path, { method, headers, body: payload, signal: ctrl.signal })
    const text = await res.text()
    try { return JSON.parse(text) } catch { return { code: -1, message: `bad json (${res.status}) ${text.slice(0, 120)}` } }
  } catch (e) {
    return { code: -2, message: `network: ${e?.message || e}` }
  } finally { clearTimeout(timer) }
}

export const get = (path, opts) => request('GET', path, opts)
export const post = (path, body, opts) => request('POST', path, { ...opts, body })

/* ────────────── 账号 ────────────── */

export async function nav(cookies) {
  const j = await get('/x/web-interface/nav', { cookies })
  if (j.code !== 0) return { ok: false, msg: `code=${j.code} ${j.message || ''}` }
  const d = j.data || {}
  return { ok: true, mid: Number(d.mid || 0), uname: String(d.uname || ''), level: Number(d.level || 0) }
}

/* ────────────── @ 通知 ────────────── */

export async function atFeed(cookies, { retries = 2 } = {}) {
  let last = null
  for (let i = 0; i <= retries; i++) {
    const j = await get('/x/msgfeed/at?build=0&mobi_app=web&platform=web', { cookies })
    if (j.code === 0) return { ok: true, items: parseAtItems(j.data?.items) }
    last = j
    await new Promise((r) => setTimeout(r, 1500))
  }
  return { ok: false, msg: `code=${last?.code ?? '?'} ${last?.message || ''}` }
}

function pick(obj, paths) {
  for (const p of paths) {
    let cur = obj
    for (const k of p) { if (cur == null) { cur = undefined; break } cur = cur[k] }
    if (cur !== undefined && cur !== null && cur !== '') return cur
  }
  return undefined
}

/** 防御式解析（接口字段没有权威表，拿不到就跳过，不猜） */
export function parseAtItems(items) {
  const out = []
  for (const raw of items || []) {
    if (!raw) continue
    const it = raw.item || {}
    const user = raw.user || {}
    const ats = Array.isArray(it.at_details) ? it.at_details.map((a) => Number(a?.mid || 0)).filter((n) => n > 0) : []
    const id = String(raw.id || '')
    const atTime = Number(raw.at_time || 0)
    if (!id || !atTime) continue
    const uri = String(it.uri || '')
    out.push({
      id,
      atTime,
      mid: Number(user.mid || 0),
      name: String(user.nickname || ''),
      title: String(it.title || ''),
      uri,
      bvid: bvidOf(uri),
      text: String(it.source_content || ''),
      oid: String(it.subject_id || ''),
      root: String(it.source_id || ''),
      biz: Number(it.business_id || 0),
      ats,
    })
  }
  return out
}

/* ────────────── 「回复我的」通知 ────────────── */

export async function replyFeed(cookies, { retries = 2 } = {}) {
  let last = null
  for (let i = 0; i <= retries; i++) {
    const j = await get('/x/msgfeed/reply?build=0&mobi_app=web&platform=web', { cookies })
    if (j.code === 0) return { ok: true, items: parseReplyItems(j.data?.items) }
    last = j
    await new Promise((r) => setTimeout(r, 1500))
  }
  return { ok: false, msg: `code=${last?.code ?? '?'} ${last?.message || ''}` }
}

/**
 * 防御式解析「回复我的」：
 *   item.target_id = 被回复的评论 rpid（我的那条）
 *   item.source_id = 对方的回复 rpid（回复时 parent 指向它）
 */
export function parseReplyItems(items) {
  const out = []
  for (const raw of items || []) {
    if (!raw) continue
    const it = raw.item || {}
    const user = raw.user || {}
    const id = String(raw.id || '')
    const atTime = Number(raw.reply_time || raw.at_time || 0)
    if (!id || !atTime) continue
    const uri = String(it.uri || '')
    const target = String(it.target_id || '')
    const source = String(it.source_id || '')
    if (!target || !source) continue
    out.push({
      id,
      atTime,
      mid: Number(user.mid || 0),
      name: String(user.nickname || ''),
      title: String(it.title || ''),
      uri,
      bvid: bvidOf(uri),
      text: String(it.source_content || it.content || ''),
      oid: String(it.subject_id || ''),
      root: target,     // verify 用它反查真正根评论
      rpid: source,     // 发送时 parent 指向它
      biz: Number(it.business_id || 1),
      source: 'reply',
    })
  }
  return out
}

/* ────────────── 评论复核（新评论延迟进列表 ⇒ 用 detail/reply 直查） ────────────── */

export async function verifyComment(cookies, item) {
  const biz = item.biz || 1
  if (!item.oid) return { ok: false, msg: '通知里没有 oid' }
  if (!item.root || item.root === '0') return { ok: false, msg: '通知里没有根评论 rpid' }
  const root = String(item.root)

  // 1) 楼中楼接口：能反查真正根评论
  const u1 = `/x/v2/reply/reply?type=${biz}&oid=${item.oid}&root=${root}&ps=20&pn=1&nohot=1`
  const j1 = await get(u1, { cookies })
  if (j1.code === 0 && j1.data) {
    const realRoot = String(j1.data.root?.rpid || root)
    const replies = Array.isArray(j1.data.replies) ? j1.data.replies : []
    const hit = replies.find((r) => String(r.rpid) === root) || j1.data.root
    if (hit) {
      return {
        ok: true,
        root: realRoot,
        rpid: String(hit.rpid || root),
        mid: Number(hit.mid || 0),
        content: String(hit.content?.message || ''),
        msg: 'ok',
      }
    }
  }

  // 2) 详情接口
  const u2 = `/x/v2/reply/detail?type=${biz}&oid=${item.oid}&root=${root}`
  const j2 = await get(u2, { cookies })
  if (j2.code === 0 && j2.data?.root) {
    const r = j2.data.root
    return {
      ok: true,
      root: String(r.rpid || root),
      rpid: String(r.rpid || root),
      mid: Number(r.mid || 0),
      content: String(r.content?.message || ''),
      msg: 'ok',
    }
  }

  return { ok: false, msg: `评论区里找不到根评论 rpid=${root}（code=${j1.code}/${j2.code}）` }
}

/* ────────────── 发评论 ────────────── */

export async function sendReply(cookies, item, text) {
  const csrf = csrfOf(cookies)
  if (!csrf) return { ok: false, msg: 'cookie 里没有 bili_jct' }
  const biz = item.biz || 1
  const parent = String(item.parent || item.rpid || item.root)
  const body = {
    oid: String(item.oid),
    type: String(biz),
    root: String(item.root),
    parent,
    message: String(text),
    csrf,
    plat: '1',
    ordering: 'heat',
    gaia_source: 'main_web',
    statistics: JSON.stringify({ appId: 100, platform: 5, version: '2.0' }),
  }
  const j = await post('/x/v2/reply/add', body, { cookies })
  if (j.code !== 0) return { ok: false, msg: `发送失败：code=${j.code} ${j.message || ''}` }
  const rpid = String(j.data?.rpid || '')
  return { ok: true, rpid }
}

/* ────────────── 可见性复查（带 cookie + 匿名 各查一次） ────────────── */

export async function checkVisible(cookies, item, rpid) {
  const biz = item.biz || 1
  const arr = [`/x/v2/reply/reply?type=${biz}&oid=${item.oid}&root=${item.root}&ps=20&pn=1`]
  const seen = async (anon) => {
    for (const u of arr) {
      for (let tryN = 0; tryN < 2; tryN++) {
        const j = anon ? await get(u, { anon: true }) : await get(u, { cookies })
        if (j.code === 0 && j.data) {
          const replies = Array.isArray(j.data.replies) ? j.data.replies : []
          if (replies.some((r) => String(r.rpid) === String(rpid))) return true
          if (String(j.data.root?.rpid || '') === String(rpid)) return true
        }
        await new Promise((r) => setTimeout(r, 2500))
      }
    }
    return false
  }
  const self = await seen(false)
  const anon = await seen(true)
  return { self, anon }
}

/* ────────────── 视频信息（时长 / 标题） ────────────── */

export function bvidOf(uri) {
  const m = String(uri || '').match(/\/video\/(BV[0-9A-Za-z]{10})/)
  return m ? m[1] : ''
}

export async function videoInfo(cookies, uri) {
  const bvid = bvidOf(uri)
  if (!bvid) return { ok: false, msg: `拿不到 BV 号（uri=${uri || '空'}）` }
  const j = await get(`/x/web-interface/view?bvid=${bvid}`, { cookies })
  if (j.code !== 0 || !j.data) return { ok: false, msg: `code=${j.code} ${j.message || ''}` }
  return {
    ok: true,
    bvid,
    aid: String(j.data.aid || ''),
    title: String(j.data.title || ''),
    duration: Number(j.data.duration || 0),
    url: `https://www.bilibili.com/video/${bvid}`,
  }
}

/* ────────────── 私信（IM，api.vc.bilibili.com，需要 wbi 签名） ────────────── */

const DEV_ID = 'A6716E9A-7CE3-47AF-994B-F0B34178D28D'
/** bilibili wbi mixin key 置换表（取自 bilibili-API-collect / bilibili_api） */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

let mixinCache = { key: '', at: 0 }

async function mixinKey(cookies) {
  if (mixinCache.key && Date.now() - mixinCache.at < 3600_000) return mixinCache.key
  const j = await get('/x/web-interface/nav', { cookies })
  if (j.code !== 0) return ''
  const pick = (u) => String(u || '').split('/').pop().split('.')[0]
  const ae = pick(j.data?.wbi_img?.img_url) + pick(j.data?.wbi_img?.sub_url)
  if (ae.length < 32) return ''
  const key = MIXIN_TAB.map((i) => ae[i] || '').join('').slice(0, 32)
  mixinCache = { key, at: Date.now() }
  return key
}

function encPart(v) {
  return encodeURIComponent(String(v)).replace(/%20/g, '+').replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function qs(params) {
  return Object.keys(params).map((k) => `${encPart(k)}=${encPart(params[k])}`).join('&')
}

/** 给参数加 wts / web_location / w_rid */
function encWbi(params, key) {
  const p = { ...params }
  p.wts = Math.floor(Date.now() / 1000)
  if (!p.web_location) p.web_location = 1550101
  const sorted = Object.keys(p).sort()
  const query = sorted.map((k) => `${encPart(k)}=${encPart(p[k])}`).join('&')
  p.w_rid = createHash('md5').update(query + key, 'utf8').digest('hex')
  return p
}

async function imGet(cookies, base, params) {
  const key = await mixinKey(cookies)
  const q = qs(key ? encWbi(params, key) : { ...params })
  return get(`${base}?${q}`, { cookies })
}

async function imPost(cookies, base, params, body) {
  const key = await mixinKey(cookies)
  const q = qs(key ? encWbi(params, key) : { ...params })
  return post(`${base}?${q}`, body, { cookies })
}

/** 把私信消息 content（JSON 字符串）里的正文抠出来 */
function msgText(content) {
  try {
    const o = JSON.parse(String(content || '{}'))
    return String(o?.content || o?.text || o?.title || '')
  } catch { return String(content || '') }
}

/** 会话列表 */
export async function imSessions(cookies) {
  const j = await imGet(cookies, `${IM_API}/session_svr/v1/session_svr/get_sessions`, {
    session_type: 1, group_fold: 1, unfollow_fold: 0, sort_rule: 2, build: 0, mobi_app: 'web',
  })
  if (j.code !== 0) return { ok: false, msg: `code=${j.code} ${j.message || ''}` }
  const list = (j.data?.session_list || []).map((s) => {
    const lm = s.last_msg || null
    return {
      talkerId: Number(s.talker_id || 0),
      unread: Number(s.unread_count || 0),
      ts: Math.round(Number(s.session_ts || 0) / 1e6), // 微秒 → 秒
      last: lm ? {
        senderUid: Number(lm.sender_uid || 0),
        receiverId: Number(lm.receiver_id || 0),
        msgType: Number(lm.msg_type || 0),
        text: msgText(lm.content),
        seqno: Number(lm.msg_seqno || 0),
        ts: Number(lm.timestamp || 0),
        msgKey: String(lm.msg_key || ''),
      } : null,
    }
  }).filter((s) => s.talkerId > 0)
  return { ok: true, list }
}

/** 拉某个会话最近的消息（新 → 旧） */
export async function imMessages(cookies, talkerId, { size = 30 } = {}) {
  const j = await imGet(cookies, `${IM_API}/svr_sync/v1/svr_sync/fetch_session_msgs`, {
    talker_id: Number(talkerId), session_type: 1, size, build: 0, mobi_app: 'web',
  })
  if (j.code !== 0) return { ok: false, msg: `code=${j.code} ${j.message || ''}` }
  const list = (j.data?.messages || []).map((m) => ({
    senderUid: Number(m.sender_uid || 0),
    receiverId: Number(m.receiver_id || 0),
    msgType: Number(m.msg_type || 0),
    text: msgText(m.content),
    seqno: Number(m.msg_seqno || 0),
    ts: Number(m.timestamp || 0),
    msgKey: String(m.msg_key || ''),
  }))
  return { ok: true, list }
}

/** 发私信（文本） */
export async function sendIM(cookies, receiverId, text, { senderUid } = {}) {
  const sender = Number(senderUid || cookies?.DedeUserID || 0)
  if (!sender) return { ok: false, msg: 'cookie 里没有 DedeUserID' }
  if (!receiverId) return { ok: false, msg: '没有收信人 uid' }
  if (!String(text || '').trim()) return { ok: false, msg: '内容为空' }
  const ts = Math.floor(Date.now() / 1000)
  const body = {
    'msg[sender_uid]': sender,
    'msg[receiver_id]': Number(receiverId),
    'msg[receiver_type]': 1,
    'msg[msg_type]': 1,
    'msg[msg_status]': 0,
    'msg[content]': JSON.stringify({ content: String(text) }),
    'msg[dev_id]': DEV_ID,
    'msg[new_face_version]': 0,
    'msg[timestamp]': ts,
    from_filework: 0,
    build: 0,
    mobi_app: 'web',
  }
  const csrf = csrfOf(cookies)
  if (csrf) body.csrf = csrf
  const j = await imPost(cookies, `${IM_API}/web_im/v1/web_im/send_msg`,
    { w_sender_uid: sender, w_receiver_id: Number(receiverId) }, body)
  if (j.code !== 0) return { ok: false, msg: `code=${j.code} ${j.message || ''}` }
  return { ok: true, msgKey: String(j.data?.msg_key || '') }
}
