/**
 * lib/ai.mjs —— 用 DSH 的 headless profile 生成一条 B 站评论
 * ============================================================================
 * 与 TS 计划任务版（watch-at-http.ps1 的 New-ReplyText）等价：
 *   dsh --profile headless --json "<任务>"
 *   → 逐行 JSON，取 {"type":"final","text":"..."} 作为回复正文。
 * 注意：headless profile 不会读 .credentials.yaml，需要 DEEPSEEK_API_KEY 环境变量；
 * 没有就现场从 <DSH_HOME>/.credentials.yaml 读 refs.DEEPSEEK_API_KEY 注入。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 从 .credentials.yaml 读 DEEPSEEK_API_KEY（没有就返回空串） */
export function readDeepseekKey() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
  const file = join(home, '.credentials.yaml')
  try {
    const text = readFileSync(file, 'utf8')
    const m = text.match(/DEEPSEEK_API_KEY\s*:\s*([\w-]+)/)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

/** 按行抓 `{"type":"final","text":...}` */
function pickFinal(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const obj = JSON.parse(t)
      if (obj && obj.type === 'final' && typeof obj.text === 'string') return obj.text
    } catch { /* 不是 JSON 行，跳过 */ }
  }
  return ''
}

/**
 * @returns {Promise<{ok:boolean, text?:string, msg?:string}>}
 */
export function generateReply({ dshBin, profile = 'headless', taskFile, timeoutMs = 180000 }) {
  return new Promise((resolve) => {
    if (!existsSync(taskFile)) return resolve({ ok: false, msg: '任务文件不存在' })
    const env = { ...process.env }
    if (!env.DEEPSEEK_API_KEY) {
      const key = readDeepseekKey()
      if (key) env.DEEPSEEK_API_KEY = key
      else return resolve({ ok: false, msg: '没有 DEEPSEEK_API_KEY（.credentials.yaml 里也没有），没法生成文案' })
    }
    // 任务参数保持纯 ASCII（中文全在 taskFile 里），避免 Windows 命令行代码页乱码
    const task = `Read the file ${String(taskFile).replace(/"/g, '')} (UTF-8 text). It contains instructions. Follow them and output ONLY the final Bilibili comment text, no quotes, no markdown fences, no extra explanation.`
    const bin = dshBin || 'dsh'
    // Windows 上 .cmd 不能直接 spawn；用 shell 执行整条命令行，路径含空格就加引号
    const binArg = /\s/.test(bin) ? `"${bin}"` : bin
    const cmdLine = `${binArg} --profile ${profile} --json "${task}"`
    let child
    try {
      child = spawn(cmdLine, [], { env, windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ ok: false, msg: `起不来 dsh：${e?.message || e}` })
    }
    let out = ''
    let err = ''
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve(r) } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } finish({ ok: false, msg: '生成文案超时' }) }, timeoutMs)
    child.stdout?.on('data', (d) => { out += d.toString('utf8') })
    child.stderr?.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, msg: `dsh 启动失败：${e?.message || e}` }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = pickFinal(out)
      if (!text) return finish({ ok: false, msg: `dsh 没输出最终文案（exit ${code}）${err.slice(-300)}` })
      finish({ ok: true, text: cleanReply(text) })
    })
  })
}

/** 去掉模型偶尔加的外壳：引号、代码块、前缀 */
export function cleanReply(text) {
  let s = String(text || '').trim()
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '')
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
  s = s.replace(/^(回复|评论|文案)[:：]\s*/i, '')
  return s.trim()
}
