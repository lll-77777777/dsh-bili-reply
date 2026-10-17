/**
 * lib/video.mjs —— 调 video-watch 技能做本地转写（不花 token、不上传云端）
 * ============================================================================
 * video-watch 的 scripts/watch.py 输出一行 `RESULT_JSON: {...}`：
 *   { ok, run_dir, transcript_txt, frames_dir, frame_count, duration, title, ... }
 * 我们读 transcript_txt 的纯文本（带 [00:05] 时间戳）交给写文案那一步。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 找 video-watch 的默认位置：$DSH_HOME/skills/video-watch */
export function defaultVideoWatchDir() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
  return join(home, 'skills', 'video-watch')
}

/**
 * @returns {Promise<{ok:boolean, transcript?:string, duration?:number, frames?:number, runDir?:string, msg?:string}>}
 */
export function transcribeVideo({ python, watchDir, url, maxTranscript = 8000, timeoutMs = 10 * 60 * 1000 }) {
  return new Promise((resolve) => {
    const script = join(watchDir || defaultVideoWatchDir(), 'scripts', 'watch.py')
    if (!existsSync(script)) return resolve({ ok: false, msg: `没找到 video-watch（${script}）` })
    const args = [script, url, '--language', 'zh', '--model', 'small', '--no-review']
    const env = {
      ...process.env,
      // 计划任务/宿主里 GPU 环境不一定齐，统一走 CPU 最稳（转写一次几十秒，能接受）
      CUDA_VISIBLE_DEVICES: '-1',
      HF_ENDPOINT: 'https://hf-mirror.com',
      HF_HUB_DISABLE_XET: '1',
    }
    let child
    try {
      child = spawn(python || 'python', args, { cwd: watchDir, env, windowsHide: true })
    } catch (e) { return resolve({ ok: false, msg: `起不来 python：${e?.message || e}` }) }
    let out = ''
    let err = ''
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve(r) } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } finish({ ok: false, msg: '转写超时' }) }, timeoutMs)
    child.stdout?.on('data', (d) => { out += d.toString('utf8') })
    child.stderr?.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, msg: `python 启动失败：${e?.message || e}` }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = out.split(/\r?\n/).find((l) => l.startsWith('RESULT_JSON: '))
      if (!line) return finish({ ok: false, msg: `watch.py 没给结果（exit ${code}）${err.slice(-200)}` })
      let j
      try { j = JSON.parse(line.slice('RESULT_JSON: '.length)) } catch { return finish({ ok: false, msg: 'watch.py 结果不是 JSON' }) }
      if (!j.ok) return finish({ ok: false, msg: j.error || 'watch.py 失败' })
      let transcript = ''
      try { if (j.transcript_txt) transcript = readFileSync(j.transcript_txt, 'utf8') } catch { transcript = '' }
      if (transcript.length > maxTranscript) transcript = transcript.slice(0, maxTranscript) + '\n（文字稿过长，已截断）'
      finish({ ok: true, transcript, duration: Number(j.duration || 0), frames: Number(j.frame_count || 0), runDir: j.run_dir || '' })
    })
  })
}
