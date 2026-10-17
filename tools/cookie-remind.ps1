# B站 SESSDATA 到期提醒
# 纯 HTTP 版看门狗靠 bili-cookie.txt 里的 SESSDATA 登录；这里每天查一次，
# 默认只在「过期前一天」开始弹 Windows 提示，提醒重新导出 cookie。
#
# 用法：
#   cookie-remind.ps1              检查一次（只剩 1 天 / 已过期才弹）
#   cookie-remind.ps1 -WarnDays 7  提前 7 天开始提醒（默认 1 = 过期前一天）
#   cookie-remind.ps1 -Test        无论如何都弹一次（验证弹窗用）

param(
    [int]$WarnDays = 1,
    [switch]$Test
)

$ToolDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$CookieFile = Join-Path $ToolDir "bili-cookie.txt"
$StateFile = Join-Path $ToolDir "cookie-remind-state.json"
$LogFile   = Join-Path $ToolDir "cookie-remind.log"

function Write-Log([string]$Message) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

$today = (Get-Date).ToString('yyyy-MM-dd')
$state = $null
if (Test-Path $StateFile) {
    try { $state = Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
}
if ($null -eq $state) { $state = New-Object psobject }
if (-not ($state.PSObject.Properties.Name -contains 'last_remind')) {
    $state | Add-Member -NotePropertyName last_remind -NotePropertyValue ''
}

$msg = ""
$titleSuffix = ""

if (-not (Test-Path $CookieFile)) {
    $msg = "纯 HTTP 版的 @ 看门狗找不到登录凭证文件。`r`n`r`n" +
           "请重新导出 B站 cookie，存到：`r`n$CookieFile`r`n`r`n" +
           "（登录 B 站 → 浏览器扩展导出 → 粘贴保存；只需要 SESSDATA 和 bili_jct 都在里面）"
} else {
    $raw = Get-Content $CookieFile -Raw -Encoding ASCII
    if ($raw -notmatch 'SESSDATA=([^;]+)') {
        $msg = "bili-cookie.txt 里没有 SESSDATA，纯 HTTP 版收不到 @ 通知。`r`n`r`n" +
               "请重新导出 B站 cookie，覆盖：`r`n$CookieFile"
    } else {
        $dec = [uri]::UnescapeDataString($Matches[1])
        $segs = $dec -split ','
        $ts = 0L
        if ($segs.Count -ge 2 -and [long]::TryParse($segs[1], [ref]$ts)) {
            $exp = ([datetime]::SpecifyKind([datetime]'1970-01-01', [DateTimeKind]::Utc)).AddSeconds([double]$ts).ToLocalTime()
            $left = $exp - (Get-Date)
            # 按「到期日」算差几天：默认 1 = 过期前一天开始弹（当天和过期后也弹，每天最多一次）
            $daysUntilExpireDate = [math]::Ceiling(($exp.Date - (Get-Date).Date).TotalDays)
            if (-not $Test -and $daysUntilExpireDate -gt $WarnDays) {
                Write-Log "SESSDATA 还有 $([math]::Round($left.TotalDays,1)) 天到期（$($exp.ToString('yyyy-MM-dd HH:mm'))），未到提醒时间（到期前 $WarnDays 天起）"
                exit 0
            }
            $days = [math]::Round($left.TotalDays, 1)
            if ($days -lt 0) {
                $titleSuffix = "已过期"
                $msg = "B站登录凭证（SESSDATA）已经过期了！`r`n`r`n" +
                       "到期时间：$($exp.ToString('yyyy-MM-dd HH:mm'))`r`n`r`n" +
                       "纯 HTTP 版的 @ 看门狗会拿不到通知，请重新导出 cookie 覆盖：`r`n$CookieFile"
            } else {
                $titleSuffix = "快过期"
                $msg = "B站登录凭证（SESSDATA）快过期了。`r`n`r`n" +
                       "还剩约 $days 天（到期：$($exp.ToString('yyyy-MM-dd HH:mm'))）`r`n`r`n" +
                       "到期后纯 HTTP 版的 @ 看门狗会收不到通知，记得重新导出 cookie 覆盖：`r`n$CookieFile"
            }
        } else {
            $msg = "bili-cookie.txt 里的 SESSDATA 解析不出过期时间（格式可能不对）。`r`n`r`n" +
                   "建议重新导出 B站 cookie 覆盖：`r`n$CookieFile"
        }
    }
}

if ($msg -eq "") { exit 0 }
if (-not $Test -and $state.last_remind -eq $today) { exit 0 }   # 今天已经提醒过，别吵

Add-Type -AssemblyName System.Windows.Forms
$title = "B站 SESSDATA 到期提醒"
if ($titleSuffix) { $title = "$title（$titleSuffix）" }
[System.Windows.Forms.MessageBox]::Show($msg, $title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null

$state.last_remind = $today
$state | ConvertTo-Json -Depth 3 | Set-Content -Path $StateFile -Encoding UTF8
Write-Log "已弹窗提醒（$today）"
