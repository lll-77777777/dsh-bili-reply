# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-bili-reply`（中文名「**B站自动回复**」）：把「B站上被 @ 了就回一条评论」做成 DSH 插件 ——
纯 HTTP 轮询、本地转写、headless 写文案，带可视化设置页。

## 帮用户安装时，按这个顺序

1. 前提（有一个就行，但**别让用户先自己装**）：
   - `dsh` 命令可用（DSH 自带的 CLI 启动器在 `E:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，
     官方 `command-manager.js` / `command-path.ps1` 会把它注册进用户 PATH）；
   - `video-watch` 技能目录（默认 `$DSH_HOME/skills/video-watch`），它自带 ffmpeg + faster-whisper；
   - 一个可用的 python（Windows 上**别用 PATH 里的 python**，那是应用商店别名，填完整 `python.exe` 路径）；
   - `.credentials.yaml` 里有 `DEEPSEEK_API_KEY`（headless 生成文案要用；插件会自己从那里读，不用手动导出）。
2. **本地目录**：`dsh plugin --profile web add link:<本目录路径>`（推荐先这样装）；
   发到 npm 之后：`dsh plugin --profile web add dsh-bili-reply`。
3. ⚠️ **提醒用户：完全退出 DSH 再打开**（bundle 层要重启才组装；刷新页面只换浏览器那半）。
4. 让用户进 **设置 → B站自动回复**：
   - 粘 Cookie（F12 → Network → 任意 `bilibili.com` 请求 → 请求头整段 Cookie，要含 `SESSDATA` + `bili_jct`）；
   - 填「主人 UID」；
   - 点「测试登录」；
   - **最后**才打开「自动回复」总开关。
5. **别擅自打开「自动回复」** —— 那是拿用户的号说话；让用户自己开。

## 已知环境差异

- ⭐ **桌面版 DSH 必须完全重启**：`bundle` 层的 `cordis.patch.yml` 只在进程启动时组装；
  只刷新页面 ⇒ 设置页里看不到「B站自动回复」。
- ⭐ **`dsh` 在 PATH 里找不到**：桌面版自带 CLI 启动器（`resources/runtime/cli/bin/dsh.cmd`），
  用官方 `command-path.ps1` 注册进用户 PATH 后新开终端才生效；插件里的 `dshBin` 留空 = 走 PATH。
- ⭐ **headless 报 `MISSING_CREDENTIAL`**：`.credentials.yaml` 有 key 但 headless profile 不读它 ——
  `lib/ai.mjs` 的 `readDeepseekKey()` 会从 `<DSH_HOME>/.credentials.yaml` 读 `refs.DEEPSEEK_API_KEY`
  并注入 `$env:DEEPSEEK_API_KEY`；如果还是没有，检查文件里有没有这一项。
- ⭐ **纯接口发评论进审核**（`state=17`，自己可见、匿名不可见）：B站对低等级号 + 纯接口 + 连发会先审后发；
  这是平台策略不是插件 bug，日志会写「已发出但匿名不可见（可能还在审核中）」。
- ⭐ **视频转写 GPU 失败**（`cublas64_12.dll not found`）：`lib/video.mjs` 固定 `CUDA_VISIBLE_DEVICES=-1` 走 CPU，
  一次转写几十秒，稳。

## 加/改设置字段时，三条硬规矩

1. 🔴 **字段必须同时加到两处**：`Config`（设置页 schema，每个字段都要 `.extra('volatile', true)`，
   否则 `settings.update()` 会抛 "no volatile fields"）和 `DEFAULTS`（`normalizeConfig()` 按 DEFAULTS 的类型挑选值，
   不在里面就**永远读不到**）。
2. `DEFAULTS` 的类型决定 `normalizeConfig()` 怎么挑值（`STR_KEYS` / `NUM_KEYS` / `BOOL_KEYS` 各一套）⇒ 类型写错等于字段失效。
3. ⭐ **改了宿主半端（`index.js` / `lib/`）必须「完全退出 DSH 再打开」**（刷新页面只换浏览器那半）。

## 仓库结构

- `index.js` —— host 半端：定时轮询 + 回复流程 + `/api/bili-reply/*` + 设置命名空间
- `client.js` —— 浏览器半端：设置页（注册在 `settings.section`，`slot id = bili-reply`）
- `lib/bili.mjs` —— B站 HTTP 接口（at 通知 / 回复我的 / 评论反查 / 发评论 / 可见性复查 / nav）
- `lib/video.mjs` —— 调 video-watch 的 `watch.py` 做本地转写（读 `RESULT_JSON`）
- `lib/ai.mjs` —— 调 `dsh --profile headless` 写文案（从 `.credentials.yaml` 注入 key）
- `lib/state.mjs` —— 家目录 / JSON 状态 / 日志
- `lib/hostdeps.mjs` —— 从宿主树取 `@deepseek-ai/schemastery`（拿不到就退到本地依赖）
- `cordis.patch.yml` —— bundle 挂载声明（默认 `enabled: false`）
