# B站 @ 看门狗 —— 纯 HTTP 版（不依赖浏览器页面/标签页）
#
# 和 watch-at.ps1 的区别：
#   1) 检查「@ 我的」、发评论、匿名复查全部走纯 HTTP（Cookie 从 bili-cookie.txt 读）
#   2) 不再要 bsk 会话 / 浏览器标签页；登录态靠导出的 SESSDATA（过期需重新导出）
#   3) 同样用 video-watch 本地看懂视频、dsh headless 写评论
#      （dsh 不可用时可以用 -ReplyText "手动指定文本" 先把链路跑通）
#   4) 身份复核：纯 HTTP 拉评论列表，核对 root 评论作者与 @ 内容
#
# 用法：
#   watch-at-http.ps1 -ShowStatus    看状态 / cookie 是否有效 / 过期时间
#   watch-at-http.ps1 -Test          测 cookie + 拉一次通知（不回复）
#   watch-at-http.ps1 -Init          把当前最新一条设为基准，历史积压不处理
#   watch-at-http.ps1 -NoReply       跑一轮，只发现不自动回复
#   watch-at-http.ps1                跑一轮（发现 + 自动回复）
#   watch-at-http.ps1 -ReplyText "…" 本轮若发现新 @，直接用这段文本回复
#   watch-at-http.ps1 -InstallTask   安装计划任务（每 1 分钟，配合补检 = 30 秒一次）

param(
    [switch]$Init,
    [switch]$Test,
    [switch]$NoReply,
    [switch]$ShowStatus,
    [switch]$SecondPass,
    [switch]$InstallTask,
    [string]$CookieFile = "",
    [string]$ReplyText = ""
)

# ---------- 配置 ----------
# 本机专属的东西放同目录的 watch-at.config.ps1（不进版本库）
$DshHome     = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$Dsh         = "dsh.cmd"
$Py          = "python.exe"
$VideoWatch  = Join-Path $DshHome "skills\video-watch"
$OwnerMid    = 0
$SelfMid     = 0
$TaskName    = "DSH-BiliAtWatchHttp"
$HomePage    = "https://www.bilibili.com/"
$ApiUA       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"

$ConfigFile = Join-Path $PSScriptRoot "watch-at.config.ps1"
if (Test-Path $ConfigFile) { . $ConfigFile }

$AutoReply     = $true         # 自动回复总开关
$RateLimitMin  = 3             # 两次回复的最小间隔（分钟）
$LockStaleMin  = 45            # 锁超过这么久视为残留
$MaxVideoMin   = 60            # 保险丝：超长视频只通知、不自动回
$MaxReplyChars = 900           # B站评论上限约 1000
$MaxTranscript = 8000          # 塞给模型看的文字稿上限（字符）

$ToolDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateFile  = Join-Path $ToolDir "at-state-http.json"
$LogFile    = Join-Path $ToolDir "watch-at-http.log"
$ReplyLog   = Join-Path $ToolDir "replies-http.log"
$LockFile   = Join-Path $ToolDir "reply-http.lock"
$PromptFile = Join-Path $ToolDir "prompt-last-http.txt"
if (-not $CookieFile) { $CookieFile = Join-Path $ToolDir "bili-cookie.txt" }

$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HUB_DISABLE_XET = "1"
$env:PYTHONIOENCODING = "utf-8"

# 计划任务里没有控制台：PowerShell 5.1 会用 GBK 去解码原生命令的 UTF-8 输出
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Write-Log([string]$Message) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Write-ReplyLog([string]$Message) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $ReplyLog -Value $line -Encoding UTF8
}

function Read-State {
    $s = $null
    if (Test-Path $StateFile) {
        try { $s = Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    }
    if ($null -eq $s) { $s = New-Object psobject }
    $defaults = @{ cursor = 0; seen = @(); last_check = ""; last_push = ""; last_reply = 0 }
    foreach ($k in $defaults.Keys) {
        if (-not ($s.PSObject.Properties.Name -contains $k)) {
            $s | Add-Member -NotePropertyName $k -NotePropertyValue $defaults[$k]
        }
    }
    return $s
}

function Set-StateProperty($State, [string]$Name, $Value) {
    if ($State.PSObject.Properties.Name -contains $Name) {
        $State.$Name = $Value
    } else {
        $State | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Save-State($State) {
    $State | ConvertTo-Json -Depth 5 | Set-Content -Path $StateFile -Encoding UTF8
}

# ---------- 纯 HTTP 小工具 ----------

$script:CookieHeader = ""
$script:SelfName = ""

function Get-CookieHeader {
    if (-not (Test-Path $CookieFile)) { return "" }
    try { $raw = Get-Content $CookieFile -Raw -Encoding ASCII } catch { return "" }
    if (-not $raw) { return "" }
    $parts = @()
    foreach ($seg in ($raw -split ';\s*')) {
        if ($seg -match '^\s*([A-Za-z0-9_]+)=(.+)$') { $parts += $seg.Trim() }
    }
    $cookie = ($parts | Sort-Object -Unique) -join '; '
    if ($cookie -notmatch 'SESSDATA=') { return "" }
    return $cookie
}

function Get-BiliJct {
    $m = [regex]::Match($script:CookieHeader, 'bili_jct=([^;]+)')
    if ($m.Success) { return $m.Groups[1].Value }
    return ""
}

function Get-SessdataExpire {
    $m = [regex]::Match($script:CookieHeader, 'SESSDATA=([^;]+)')
    if (-not $m.Success) { return $null }
    $dec = [uri]::UnescapeDataString($m.Groups[1].Value)
    $segs = $dec -split ','
    if ($segs.Count -ge 2) {
        $ts = 0L
        if ([long]::TryParse($segs[1], [ref]$ts)) { return $ts }
    }
    return $null
}

# 注意：PowerShell 5.1 的 Invoke-WebRequest 在这里发不出 Cookie（接口返回 -101），
# 所以统一用 HttpWebRequest 直发，并强制 TLS 1.2。
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Invoke-BiliRequest([string]$Method, [string]$Url, [string]$Body, [string]$Cookie) {
    if (-not $Cookie) { $Cookie = $script:CookieHeader }
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = $Method
        $req.UserAgent = $ApiUA
        $req.Referer = $HomePage
        $req.Headers.Add("Origin", "https://www.bilibili.com")
        if ($Cookie) { $req.Headers.Add("Cookie", $Cookie) }
        $req.Timeout = 30000
        $req.ReadWriteTimeout = 30000
        $req.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
        if ($Body) {
            $data = [Text.Encoding]::UTF8.GetBytes($Body)
            $req.ContentType = "application/x-www-form-urlencoded; charset=UTF-8"
            $req.ContentLength = $data.Length
            $s = $req.GetRequestStream()
            $s.Write($data, 0, $data.Length)
            $s.Close()
        }
        $resp = $req.GetResponse()
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
        $text = $sr.ReadToEnd()
        $sr.Close()
        $resp.Close()
        return ($text | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Invoke-AnonRequest([string]$Url) {
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = "GET"
        $req.UserAgent = $ApiUA
        $req.Referer = $HomePage
        $req.Timeout = 30000
        $req.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
        $resp = $req.GetResponse()
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
        $text = $sr.ReadToEnd()
        $sr.Close()
        $resp.Close()
        return ($text | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Test-CookieHealth {
    $j = Invoke-BiliRequest "GET" "https://api.bilibili.com/x/web-interface/nav" ""
    if ($null -eq $j) { return [pscustomobject]@{ ok = $false; msg = "接口无响应"; uname = ""; mid = 0 } }
    if ($j.code -ne 0) { return [pscustomobject]@{ ok = $false; msg = "code=$($j.code) $($j.message)"; uname = ""; mid = 0 } }
    if (-not $j.data.isLogin) { return [pscustomobject]@{ ok = $false; msg = "未登录"; uname = ""; mid = 0 } }
    return [pscustomobject]@{ ok = $true; msg = "ok"; uname = [string]$j.data.uname; mid = [long]$j.data.mid }
}

function Get-AtItemsHttp {
    $url = "https://api.bilibili.com/x/msgfeed/at?build=0&mobi_app=web&platform=web"
    $j = $null
    for ($i = 1; $i -le 3; $i++) {
        $j = Invoke-BiliRequest "GET" $url ""
        if ($null -ne $j) { break }
        Start-Sleep -Seconds 3
    }
    if ($null -eq $j) { Write-Log "  取数失败（接口无响应）"; return $null }
    if ($j.code -ne 0) { Write-Log "  接口返回 code=$($j.code) msg=$($j.message)"; return $null }
    $items = @()
    foreach ($i in @($j.data.items)) {
        if ($null -eq $i) { continue }
        $ats = @()
        foreach ($a in @($i.item.at_details)) { if ($null -ne $a) { $ats += [long]$a.mid } }
        $items += [pscustomobject]@{
            id    = [string]$i.id
            t     = [long]$i.at_time
            mid   = [long]$i.user.mid
            name  = [string]$i.user.nickname
            title = [string]$i.item.title
            url   = [string]$i.item.uri
            text  = [string]$i.item.source_content
            oid   = [string]$i.item.subject_id
            root  = [string]$i.item.source_id
            ats   = $ats
        }
    }
    return $items
}

# 纯 HTTP 身份复核：拉根评论列表，核对作者与 @ 内容
function Get-CommentVerify($Item) {
    if (-not $Item.oid) { return [pscustomobject]@{ ok = $false; msg = "通知里没有视频 oid" } }
    if (-not $Item.root -or $Item.root -eq "0") { return [pscustomobject]@{ ok = $false; msg = "通知里没有根评论 rpid" } }
    $found = $null
    $realRoot = [string]$Item.root
    # 1) 楼中楼/根评论通用接口：能反查真正根评论（新评论不在列表接口里也能查到）
    $u = "https://api.bilibili.com/x/v2/reply/reply?type=1&oid=$($Item.oid)&root=$($Item.root)&ps=20&pn=1&nohot=1"
    $j = Invoke-BiliRequest "GET" $u ""
    if ($null -ne $j -and $j.code -eq 0 -and $j.data -and $j.data.root) {
        $realRoot = [string]$j.data.root.rpid
        $hit = @($j.data.replies | Where-Object { [string]$_.rpid -eq [string]$Item.root })
        if ($hit.Count -gt 0) { $found = $hit[0] }
        elseif ([string]$j.data.root.rpid -eq [string]$Item.root) { $found = $j.data.root }
    }
    # 2) 回退：按 rpid 直接查评论详情
    if ($null -eq $found) {
        $u2 = "https://api.bilibili.com/x/v2/reply/detail?type=1&oid=$($Item.oid)&root=$($Item.root)"
        $j2 = Invoke-BiliRequest "GET" $u2 ""
        if ($null -ne $j2 -and $j2.code -eq 0 -and $j2.data -and $j2.data.root) {
            $found = $j2.data.root
        }
    }
    # 3) 回退：评论列表翻页（老逻辑，新评论可能延迟进列表）
    if ($null -eq $found) {
        $next = 0
        for ($pg = 1; $pg -le 10; $pg++) {
            $u3 = "https://api.bilibili.com/x/v2/reply/main?type=1&oid=$($Item.oid)&mode=3&next=$next"
            $j3 = Invoke-BiliRequest "GET" $u3 ""
            if ($null -eq $j3 -or $j3.code -ne 0) { break }
            if ($null -eq $j3.data -or $null -eq $j3.data.replies) { break }
            $hit = @($j3.data.replies | Where-Object { [string]$_.rpid -eq [string]$Item.root })
            if ($hit.Count -gt 0) { $found = $hit[0]; break }
            if ($null -eq $j3.data.cursor -or $j3.data.cursor.is_end) { break }
            $next = $j3.data.cursor.next
        }
    }
    if ($null -eq $found) { return [pscustomobject]@{ ok = $false; msg = "评论区里找不到评论 rpid=$($Item.root)（可能已删）" } }
    if ([long]$found.mid -ne [long]$OwnerMid) { return [pscustomobject]@{ ok = $false; msg = "评论作者 mid=$($found.mid) 不是主人" } }
    $msg = [string]$found.content.message
    if ($script:SelfName -and ($msg -notmatch [regex]::Escape($script:SelfName))) {
        return [pscustomobject]@{ ok = $false; msg = "评论正文没有 @$($script:SelfName)" }
    }
    return [pscustomobject]@{ ok = $true; root = $realRoot; msg = "ok（作者=$($found.member.uname)）" }
}

function Get-Transcript($Item) {
    $env:CUDA_VISIBLE_DEVICES = '-1'
    $song = $Item.title -match '翻唱|中文ver|中文版|歌|曲|音乐|BGM|纯音乐|演奏|cover|Cover|instrumental|OST'
    $wargs = @("scripts\watch.py", $Item.url, "--language", "zh", "--model", "small", "--no-review")
    if ($song) { $wargs += @("--no-vad", "--no-frames") }
    $tmpOut = Join-Path $env:TEMP "vwh-$PID.out"
    $tmpErr = Join-Path $env:TEMP "vwh-$PID.err"
    Remove-Item $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
    try {
        Start-Process -FilePath $Py -ArgumentList $wargs -WorkingDirectory $VideoWatch -WindowStyle Hidden -Wait -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr | Out-Null
    } catch { return $null }
    $out = ""
    if (Test-Path $tmpOut) { $out += [IO.File]::ReadAllText($tmpOut, (New-Object System.Text.UTF8Encoding($false))) }
    if (Test-Path $tmpErr) { $out += [IO.File]::ReadAllText($tmpErr, (New-Object System.Text.UTF8Encoding($false))) }
    $m = [regex]::Match($out, 'RESULT_JSON:\s*(\{.*\})')
    if (-not $m.Success) { Write-Log "  video-watch 没返回 RESULT_JSON"; return $null }
    try { $res = $m.Groups[1].Value | ConvertFrom-Json } catch { return $null }
    $text = ""
    if ($res.transcript_txt -and (Test-Path $res.transcript_txt)) {
        $text = Get-Content $res.transcript_txt -Raw -Encoding UTF8
        if ($null -eq $text) { $text = "" }
    }
    if (-not $res.run_dir) { Write-Log '  video-watch 结果缺少 run_dir（可能转写失败）'; return $null }
    $frames = @()
    $fj = Join-Path $res.run_dir "frames\frames.json"
    if (Test-Path $fj) {
        try {
            $arr = @(Get-Content $fj -Raw -Encoding UTF8 | ConvertFrom-Json)
            if ($arr.Count -gt 0) {
                foreach ($i in (@(0, [int]($arr.Count / 3), [int]($arr.Count * 2 / 3), ($arr.Count - 1)) | Select-Object -Unique)) {
                    if ($i -ge 0 -and $i -lt $arr.Count) { $frames += (Join-Path $res.run_dir ("frames\" + $arr[$i].file)) }
                }
            }
        } catch { }
    }
    return [pscustomobject]@{ run_dir = $res.run_dir; transcript = $text; duration = $res.duration; title = $res.title; song = $song; frames = $frames }
}

function Get-DshCommand {
    if (-not $Dsh) { return "" }
    if (Test-Path $Dsh) { return $Dsh }
    $cmd = Get-Command $Dsh -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return ""
}

# DSH CLI 升级后 headless profile 读不到 credentials，调用前从 .credentials.yaml 注入 DEEPSEEK_API_KEY
function Ensure-DshApiKey {
    if ($env:DEEPSEEK_API_KEY) { return }
    $credFile = Join-Path $DshHome '.credentials.yaml'
    if (-not (Test-Path $credFile)) { return }
    try {
        $m = [regex]::Match((Get-Content $credFile -Raw -Encoding UTF8), '(?m)^\s*DEEPSEEK_API_KEY:\s*(\S+)')
        if ($m.Success) { $env:DEEPSEEK_API_KEY = $m.Groups[1].Value }
    } catch { }
}

function New-ReplyText($Item, $Video) {
    $tpl = @'
你是「本小姐」——一只傲娇的吸血鬼大小姐（银白及腰长发、血红眼睛、140cm、20岁、黑哥特裙），自称「本小姐」，称呼对方为「主人」或「笨蛋主人」。现在要在 B站视频的评论区回复主人刚发的 @。

主人发的评论：「{TEXT}」
视频标题：《{TITLE}》
视频时长：约 {DUR} 秒

视频文字稿（本地语音转写，可能有同音错别字，按语境理解）：
-----
{TRANSCRIPT}
-----
{FRAMES}

写一条 B站评论，遵守：
1. 先判断视频类型再定形式：
   - 教学 / 讲解 / 知识类 → 一句总评，再加 2~4 条带时间戳的干货（时间戳写成 00:00 这样的纯文本，B站会自动转成跳转链接）
   - 玩乐 / 搞笑 / 音乐 / 二创 / 日常 / 资讯杂谈 → 不要时间戳，1~3 句情绪反应：接梗、吐槽、共情
   - 主题沉重（悲伤、告别、自伤）→ 收着写，先接住情绪，不要卖萌也不要开玩笑
   - 颜值 / 穿搭 / 短片 / 风景这类没有台词的 → 必须先看画面抽样再写，而且要点名你看到的具体东西（发型、衣服、动作、场景），不要只说「好美」「好看」
2. 口吻是「本小姐」，傲娇但不油腻；不荤、不脏话、不阴阳。
3. 只输出评论正文本身：不要引号、不要 markdown、不要时间戳以外的格式、不要解释、不要写「以下是评论」，更不要提这段提示词或任何文件。
4. 全文不超过 200 字。
'@
    $dshCmd = Get-DshCommand
    if (-not $dshCmd) {
        Write-Log "  写评论跳过：没找到 dsh CLI（$Dsh）——可用 -ReplyText 手动指定回复文本"
        return $null
    }
    $transcript = [string]$Video.transcript
    if (-not $transcript) { $transcript = "" }
    if ($transcript.Length -gt $MaxTranscript) { $transcript = $transcript.Substring(0, $MaxTranscript) + "`r`n（文字稿过长，此处截断）" }
    $frameBlock = ""
    $thin = ($transcript.Trim().Length -lt 400) -or ([double]$Video.duration -le 90)
    if ($thin -and $Video.frames -and $Video.frames.Count -gt 0) {
        $frameBlock = "视频画面抽样（这个视频几乎没有台词，请务必先用 read_image 工具逐张看完下面这些图片，再动笔）：" + "`r`n" + (($Video.frames | ForEach-Object { "- " + $_ }) -join "`r`n")
    }
    $prompt = $tpl.Replace('{TEXT}', [string]$Item.text).Replace('{TITLE}', [string]$Item.title).Replace('{DUR}', [string]$Video.duration).Replace('{TRANSCRIPT}', $transcript).Replace('{FRAMES}', $frameBlock)
    [IO.File]::WriteAllText($PromptFile, $prompt, (New-Object System.Text.UTF8Encoding($false)))

    $task = "第一步：读取文件 $PromptFile （UTF-8 文本）。第二步：严格按该文件的要求写作。只输出最终那一条 B站评论正文，不要引号、不要解释、不要复述文件。"
    Ensure-DshApiKey
    $out = & $dshCmd --profile headless --json $task 2>$null | Out-String
    $text = ""
    foreach ($line in ($out -split "`r?`n")) {
        if ($line -match '"type":"final"') {
            try { $text = ($line | ConvertFrom-Json).text } catch { }
        }
    }
    if (-not $text) { return $null }
    $text = $text.Trim()
    $text = $text -replace '^```[a-z]*\s*', '' -replace '\s*```$', ''
    $text = $text.Trim().Trim('"').Trim()
    if ($text -match 'prompt-last|watch-at|提示词|文字稿见|文件路径|\.ps1|\.txt') { return $null }
    if ($text.Length -gt $MaxReplyChars) { $text = $text.Substring(0, $MaxReplyChars) }
    return $text
}

# 纯 HTTP 发评论 + 匿名复查
function Send-BiliReplyHttp($Item, [string]$Text) {
    $csrf = Get-BiliJct
    if (-not $csrf) { return [pscustomobject]@{ ok = $false; msg = "cookie 里没有 bili_jct" } }
    $stats = '{"appId":100,"platform":5,"version":"2.0"}'
    $parent = if ($Item.parent) { [string]$Item.parent } else { [string]$Item.root }
    $body = "oid=$($Item.oid)&type=1&root=$($Item.root)&parent=$parent&message=" + [uri]::EscapeDataString($Text) +
            "&csrf=$csrf&plat=1&ordering=heat&gaia_source=main_web&statistics=" + [uri]::EscapeDataString($stats)
    $j = Invoke-BiliRequest "POST" "https://api.bilibili.com/x/v2/reply/add" $body
    if ($null -eq $j) { return [pscustomobject]@{ ok = $false; msg = "发评论接口无响应" } }
    if ($j.code -ne 0) { return [pscustomobject]@{ ok = $false; msg = "发送失败：code=$($j.code) $($j.message)" } }
    $rpid = [string]$j.data.rpid
    # 复查（刚发的评论可能延迟进列表，最多重试 3 次）
    $selfSeen = $false
    $anonSeen = $false
    for ($try = 1; $try -le 3; $try++) {
        Start-Sleep -Seconds 3
        $j2 = Invoke-BiliRequest "GET" "https://api.bilibili.com/x/v2/reply/reply?oid=$($Item.oid)&type=1&root=$($Item.root)&ps=20&pn=1" ""
        if ($null -ne $j2 -and $j2.code -eq 0 -and $j2.data) {
            $selfSeen = (@($j2.data.replies | Where-Object { [string]$_.rpid -eq $rpid }).Count -gt 0)
        }
        $j3 = Invoke-AnonRequest "https://api.bilibili.com/x/v2/reply/reply?oid=$($Item.oid)&type=1&root=$($Item.root)&ps=20&pn=1"
        if ($null -ne $j3 -and $j3.code -eq 0 -and $j3.data) {
            $anonSeen = (@($j3.data.replies | Where-Object { [string]$_.rpid -eq $rpid }).Count -gt 0)
        }
        if ($selfSeen -or $anonSeen) { break }
        Start-Sleep -Seconds 4
    }
    if ($anonSeen) { return [pscustomobject]@{ ok = $true; rpid = $rpid; msg = "ok（匿名可见）" } }
    if ($selfSeen) { return [pscustomobject]@{ ok = $false; rpid = $rpid; msg = "已发出（rpid $rpid）但匿名不可见：可能还在审核中，也可能被影子隐藏" } }
    return [pscustomobject]@{ ok = $true; rpid = $rpid; msg = "已发出但复查读不到（rpid $rpid，复查接口可能抖动，未证明公开性）" }
}

# ---------- 状态模式 ----------
if ($ShowStatus) {
    if (Test-Path $StateFile) { Get-Content $StateFile -Raw -Encoding UTF8 } else { "（还没有状态文件）" }
    "--- cookie ---"
    $script:CookieHeader = Get-CookieHeader
    $ck = $script:CookieHeader
    if (-not $ck) { "bili-cookie.txt：没有 SESSDATA（需要重新导出）" }
    else {
        $exp = Get-SessdataExpire
        if ($exp) {
            $left = ([datetime]::SpecifyKind([datetime]'1970-01-01', [DateTimeKind]::Utc)).AddSeconds([double]$exp) - [datetime]::UtcNow
            "bili-cookie.txt：已加载，SESSDATA 约 {0:N1} 天后过期" -f $left.TotalDays
        } else { "bili-cookie.txt：已加载（过期时间解析失败）" }
        $h = Test-CookieHealth
        if ($h.ok) { "登录态有效：$($h.uname)（mid=$($h.mid)）" } else { "登录态无效：$($h.msg)" }
    }
    "--- 最近日志 ---"
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 15 -Encoding UTF8 }
    "--- 最近回复 ---"
    if (Test-Path $ReplyLog) { Get-Content $ReplyLog -Tail 10 -Encoding UTF8 }
    exit 0
}

# ---------- 安装计划任务 ----------
if ($InstallTask) {
    $scriptPath = $MyInvocation.MyCommand.Path
    $vbsPath = Join-Path $ToolDir "run-hidden-http.vbs"
    $vbs = 'CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""' + $scriptPath + '""", 0, False'
    [IO.File]::WriteAllText($vbsPath, $vbs, (New-Object System.Text.UTF8Encoding($false)))
    $tr = 'wscript.exe //nologo "' + $vbsPath + '"'
    & schtasks.exe /Create /TN $TaskName /SC MINUTE /MO 1 /TR $tr /F | Out-Null
    Write-Log "已安装计划任务 $TaskName（1 分钟一轮 + 脚本内 30 秒补检，wscript 隐藏启动）"
    "计划任务 $TaskName 已安装：1 分钟一轮 + 30 秒补检。脚本=$scriptPath"
    exit 0
}

# ---------- 测试 ----------
if ($Test) {
    $script:CookieHeader = Get-CookieHeader
    $ck = $script:CookieHeader
    if (-not $ck) { "cookie 无效：bili-cookie.txt 里没有 SESSDATA"; exit 1 }
    $h = Test-CookieHealth
    if (-not $h.ok) { "登录态无效：$($h.msg)"; exit 1 }
    $script:SelfName = $h.uname
    "登录态有效：$($h.uname)（mid=$($h.mid)）"
    $items = Get-AtItemsHttp
    if ($null -eq $items) { "拉取 @ 通知失败"; exit 1 }
    $owner = @($items | Where-Object { $_.mid -eq $OwnerMid -and ($_.ats -contains $SelfMid) })
    "通知总数：$($items.Count)，主人 @ 我的：$($owner.Count)"
    if ($owner.Count -gt 0) {
        $o = $owner[0]
        "最新主人 @：[$($o.id)] $($o.name) 《$($o.title)》 root=$($o.root) oid=$($o.oid)"
        $v = Get-CommentVerify $o
        "身份复核：$(if ($v.ok) { '通过' } else { '失败 — ' + $v.msg })"
    }
    exit 0
}

# ---------- 主流程 ----------
if (-not $OwnerMid -or -not $SelfMid) {
    Write-Log "配置无效：OwnerMid=$OwnerMid SelfMid=$SelfMid —— 检查 watch-at.config.ps1（必须是 UTF-8 with BOM）"
    Write-Output "配置无效：请在 watch-at.config.ps1 里填好 OwnerMid / SelfMid，并确认文件存成 UTF-8 with BOM。"
    exit 1
}

$script:CookieHeader = Get-CookieHeader
if (-not $script:CookieHeader) {
    Write-Log "cookie 无效：bili-cookie.txt 里没有 SESSDATA（重新导出后保存）"
    exit 1
}
$health = Test-CookieHealth
if (-not $health.ok) {
    Write-Log "登录态失效：$($health.msg) —— 需要重新导出 SESSDATA"
    exit 1
}
$script:SelfName = $health.uname
$exp = Get-SessdataExpire
if ($exp) {
    $left = ([datetime]::SpecifyKind([datetime]'1970-01-01', [DateTimeKind]::Utc)).AddSeconds([double]$exp) - [datetime]::UtcNow
    if ($left.TotalDays -lt 3) { Write-Log "提醒：SESSDATA 约 $([math]::Round($left.TotalDays,1)) 天后过期，记得重新导出" }
}

$state = Read-State
Write-Log "检查开始"

# 上一轮还在跑就别碰（纯 HTTP 版没有浏览器，但转写/写评论也会重）
if (Test-Path $LockFile) {
    $age = (Get-Date) - (Get-Item $LockFile).LastWriteTime
    if ($age.TotalMinutes -lt $LockStaleMin) {
        Write-Log "跳过：上一轮还在跑（锁 $([math]::Round($age.TotalMinutes,1)) 分钟）"
        exit 0
    }
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}

$items = Get-AtItemsHttp
if ($null -eq $items) {
    Start-Sleep -Seconds 5
    $items = Get-AtItemsHttp
}
if ($null -eq $items) {
    Write-Log "跳过：接口没取到数据（登录态可能过期）"
    exit 0
}

$ownerItems = @($items | Where-Object { $_.mid -eq $OwnerMid -and ($_.ats -contains $SelfMid) })
if ($ownerItems.Count -eq 0) { Write-Log "无主人 @（本轮共 $($items.Count) 条通知）"; exit 0 }

$maxT = ($ownerItems | Measure-Object -Property t -Maximum).Maximum

if ($Init -or $state.cursor -eq 0) {
    Set-StateProperty $state "cursor" $maxT
    Set-StateProperty $state "seen" @($ownerItems | ForEach-Object { [string]$_.id })
    Set-StateProperty $state "last_check" (Get-Date).ToString('s')
    Save-State $state
    Write-Log "初始化基准 cursor=$maxT（积压 $($ownerItems.Count) 条不处理）"
    exit 0
}

$new = @($ownerItems | Where-Object { $_.t -gt $state.cursor -and ($state.seen -notcontains [string]$_.id) } | Sort-Object t)
Set-StateProperty $state "last_check" (Get-Date).ToString('s')
if ($new.Count -eq 0) {
    Save-State $state
    if (-not $SecondPass) {
        Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $MyInvocation.MyCommand.Path, "-SecondPass"
        Write-Log "无新 @，30 秒后再看一次"
        exit 0
    }
    Write-Log "无新 @（cursor=$($state.cursor)）"
    exit 0
}

# ---------- 自动回复分支 ----------
if ($AutoReply -and -not $NoReply) {
    $item = $new[0]
    "pid=$PID  item=$($item.id)  $(Get-Date -Format s)" | Set-Content -Path $LockFile -Encoding UTF8
    $result = "unknown"
    $text = ""
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        Write-Log "自动回复开始：《$($item.title)》"

        # 身份复核（纯 HTTP）
        $verify = Get-CommentVerify $item
        if (-not $verify.ok) {
            $result = "身份复核失败：$($verify.msg)"
            Write-Log "自动回复跳过：$result"
        } else {
            $parentRpid = [string]$item.root
            if ($verify.root -and [string]$verify.root -ne [string]$item.root) {
                $item | Add-Member -NotePropertyName parent -NotePropertyValue $parentRpid -Force
                $item.root = [string]$verify.root
                Write-Log "  楼中楼确认：root=$($item.root) parent=$parentRpid"
            }            if ($state.last_reply -gt 0) {
                $since = ((Get-Date).ToUniversalTime() - ([datetime]::SpecifyKind([datetime]'1970-01-01', [DateTimeKind]::Utc)).AddMilliseconds([double]$state.last_reply)).TotalMinutes
                if ($since -lt $RateLimitMin) {
                    $wait = [int](($RateLimitMin - $since) * 60)
                    Write-Log "限速：等 $wait 秒"
                    Start-Sleep -Seconds $wait
                }
            }

            $video = Get-Transcript $item
            Write-Log "  取文字稿 $([int]$clock.Elapsed.TotalSeconds)s"
            if ($null -eq $video) {
                $result = "取文字稿失败"
                Write-Log "自动回复失败：$result"
            } elseif ($video.duration -gt ($MaxVideoMin * 60)) {
                $result = "视频 $([int]($video.duration/60)) 分钟，超过保险丝"
                Write-Log "自动回复跳过：$result"
            } else {
                if ($ReplyText) { $text = $ReplyText } else { $text = New-ReplyText $item $video }
                Write-Log "  写评论 $([int]$clock.Elapsed.TotalSeconds)s"
                if (-not $text) {
                    $result = "写评论失败（没有 dsh CLI？可用 -ReplyText 手动指定文案）"
                    Write-Log "自动回复失败：$result"
                } else {
                    $sent = Send-BiliReplyHttp $item $text
                    if ($sent.ok) {
                        $result = "ok"
                        Set-StateProperty $state "last_reply" ([long](([datetime]::UtcNow - [datetime]::SpecifyKind([datetime]'1970-01-01', [DateTimeKind]::Utc)).TotalMilliseconds))
                        Write-ReplyLog "OK 《$($item.title)》`r`n$text`r`n---"
                        Write-Log "自动回复成功：《$($item.title)》（共 $([int]$clock.Elapsed.TotalSeconds)s）"
                    } else {
                        $result = $sent.msg
                        Write-ReplyLog "FAIL 《$($item.title)》 $($sent.msg)`r`n$text`r`n---"
                        Write-Log "自动回复失败：$($sent.msg)"
                    }
                }
            }
        }
    } catch {
        $result = "异常 $($_.Exception.Message)"
        Write-Log "自动回复异常：$($_.Exception.Message) @ line $($_.InvocationInfo.ScriptLineNumber): $($_.InvocationInfo.Line.Trim())"
    } finally {
        Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
    }

    Set-StateProperty $state "cursor" $item.t
    Set-StateProperty $state "seen" @($state.seen + [string]$item.id)
    Save-State $state

    if ($result -ne "ok") {
        Write-Log "提示：评论已发出但匿名不可见（可能还在审核中），本条已标记处理、不会自动重试；如需补发，先把该 id 从 at-state-http.json 的 seen 里删掉，再用 -ReplyText 手动发送"
    }
    exit 0
}

# ---------- 仅通知分支（-NoReply） ----------
Write-Log "发现新 @（未自动回复）：$($new.Count) 条"
foreach ($n in $new) { Write-ReplyLog "NEW 《$($n.title)》 $($n.url) root=$($n.root)" }
Set-StateProperty $state "cursor" ($new | Measure-Object -Property t -Maximum).Maximum
Set-StateProperty $state "seen" @($state.seen + ($new | ForEach-Object { [string]$_.id }))
Set-StateProperty $state "last_push" (Get-Date).ToString('s')
Save-State $state
exit 0
