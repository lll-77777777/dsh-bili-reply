/**
 * lib/state.mjs —— 插件家目录 / 状态文件 / 日志
 * ============================================================================
 * 约定（跟 dsh-bili-scroll 一样）：
 *   · 配置与运行数据都放在 `$DSH_HOME/bili-reply/`，**不写进插件包目录**
 *   · 状态文件 `state.json`：cursor / seen / lastReplyAt / lastResult
 *   · 日志 `reply.log`：每次检查/回复一行（设置页显示 tail）
 *   · 回复记录 `replies.jsonl`：每次真正发出去的评论（rpid + 文案）
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function stateDirOf() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'bili-reply')
}

export function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }) } catch { /* 已存在就算 */ }
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, obj) {
  try {
    ensureDir(join(file, '..'))
    writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
    return true
  } catch { return false }
}

export function appendLog(file, line) {
  try {
    ensureDir(join(file, '..'))
    appendFileSync(file, `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch { /* 日志写不进去也没关系 */ }
}

export function tail(file, n) {
  try {
    const text = readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/).filter((x) => x.length > 0)
    return lines.slice(-Math.max(1, n)).join('\n')
  } catch { return '' }
}

export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
