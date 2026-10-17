# dsh-bili-reply —— B站「@我的」自动回复（DSH 插件）

把「被 @ 了就去视频底下回一条」这件事做成 DSH 插件：**纯 HTTP 轮询、不用开浏览器**，
带一个可视化的设置页（设置 → **B站自动回复**）。

## 它怎么工作

1. 每 60 秒（可开 30 秒补检）用 Cookie 直接调 `bilibili.com` 的「@我的」和「回复我的」通知接口；
2. **默认只处理「主人 UID @ 我」**；可以打开「回复所有人」（任何人的 @ 都回）或「回复我的」（别人回复我发的评论时也回）；
3. 视频类：调 [video-watch](https://github.com/xiaohui5206/let-ai-read-video) 技能做**本地转写**（ffmpeg + faster-whisper，不传云端、不花 token），
   再把文字稿交给 `dsh --profile headless` 写一条带时间戳的评论；
4. 纯 HTTP 发楼中楼（`/x/v2/reply/add`），发完带 Cookie + 匿名各复查一次可见性
   （匿名看不到 = 大概率还在审核中，日志会写清楚）；
5. 楼中楼自动纠根（`reply/reply` 反查真正的根评论），身份复核先确认「这条 @ 真是主人的评论」；
6. **限额**：主人的 @ 永远优先、不计入上限；「回复所有人」可设「每 N 分钟内最多回 M 条」，
   设置页直接显示「本窗口剩 X / Y 条」和额度恢复时间；
7. **人设**：设置页可以填一个 `.md` 人设文件，回复会按里面的人设说话；但称呼规则优先——
   只有主人 @ 才叫「主人」，其他人一律叫「你」；
8. 启动时自检 Cookie 登录态和到期天数，每次被 @ / 回复都会记一条到「被 @ 与回复记录」，
   设置页点「查看最近 1 天」才拉取（不常驻刷新）。

## 安装

```bash
# 本地开发 / 直接装这个目录
dsh plugin --profile web add link:<本目录路径>
# 或者发布到 npm 之后
dsh plugin --profile web add dsh-bili-reply
```

⚠️ **装完必须完全退出 DSH 再打开**（bundle 层要重启才组装；只刷新页面不够）。

## 第一次用

1. 打开 **设置 → B站自动回复**；
2. 把浏览器里 B站的 Cookie 粘进「账号绑定」（F12 → Network → 任意 `bilibili.com` 请求 → 请求头里整段 Cookie，
   要含 `SESSDATA` 和 `bili_jct`）；
3. 填「主人 UID」（主人 @ 优先回复、不受限）；
4. 可选：打开「回复所有人」（回所有 @，受限额约束）或「回复我的」（回别人对我评论的回复）；
5. 可选：在「人设」里填 `.md` 人设文件路径，让回复带人设风格；
6. 点「测试登录」确认账号对；
7. 再打开「自动回复」总开关 —— 之后它自己轮询。

## 配置项

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `enabled` | 自动回复总开关 | 关 |
| `ownerMid` | 主人 UID（优先回复、不受限） | 0 |
| `replyAll` | 回复所有人：任何人的 @ 都回（其他人受限额约束） | 关 |
| `watchReplies` | 回复我的：别人回复我发的评论时也回 | 关 |
| `maxReplies` | 每时间窗口最多回复几条（0 = 不限，只约束「其他人」） | 0 |
| `maxRepliesWindowMin` | 上面那个时间窗口多少分钟 | 60 |
| `rateLimitMin` | 两条回复之间最少隔几分钟（风控友好） | 3 |
| `maxVideoMin` | 视频超过多少分钟不看（0 = 不限） | 60 |
| `secondPass` | 每轮检查完 30 秒再补查一次 | 开 |
| `noReply` | 只看模式：发现 @ 只写日志不回复 | 关 |
| `cookie` | 浏览器 Cookie 头（存本机插件家目录） | 空 |
| `dshBin` | dsh 命令路径（写文案用），留空 = PATH | 空 |
| `headlessProfile` | 生成文案的 profile | `headless` |
| `videoWatchDir` | video-watch 技能目录 | `$DSH_HOME/skills/video-watch` |
| `pythonPath` | python 解释器完整路径（Windows 建议填） | 空 |
| `replyChars` | 回复最多多少字 | 120 |
| `transcriptMax` | 文字稿最多喂多少字 | 8000 |
| `personaFile` | 人设文件（.md）路径，留空 = 内置默认人设 | 空 |

## 家目录

`$DSH_HOME/bili-reply/`：

- `config.json` —— 设置页数据（Cookie 也在这，**不进插件包、不要提交**）
- `state.json` —— `cursor` / `replyCursor` / `seen` / `lastReplyAt` / `replyTimes` / `lastResult`
- `reply.log` —— 每次检查/回复一行（设置页显示 tail）
- `replies.jsonl` —— 每次真正发出去的评论（rpid + 文案 + 是否匿名可见）
- `mentions.jsonl` —— 「被 @ 与回复记录」（设置页点「查看最近 1 天」才拉取）
- `prompt-last.txt` —— 最后一次交给 headless 的提示词（排查用）

## 限制

- B站对**低等级号 + 纯接口发布 + 短时间内连发**的评论会进审核队列（`state=17`），
  这段时间「自己可见、匿名不可见」是正常的 —— 不是发失败，等审核放行即可；
- 想稳一点：把「两条之间最少隔几分钟」调大、文案短一点、别一天回太多；
- 回复所有人 / 回复我的受「每 N 分钟最多 M 条」限制；主人的 @ 永远优先、不计入上限；
- Cookie 会过期（SESSDATA 一般 180 天）：设置页会显示剩余天数，快过期前换掉。

## 许可

MIT。纯 HTTP 接口调用与鉴权参考了 [dsh-bilibili-reply](https://github.com/bronyacccxz/dsh-bilibili-reply)（原作者 @bronyacccxz）；
视频转写依赖 [video-watch](https://github.com/xiaohui5206/let-ai-read-video)。
