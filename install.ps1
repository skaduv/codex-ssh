param(
  [string]$MarketplaceSource = "skaduv/codex-ssh",
  [string]$Ref = "main",
  [string]$Marketplace = "skaduv",
  [string]$PluginId = "codex-ssh@skaduv",
  [string]$HttpsProxy = $env:HTTPS_PROXY
)

$ErrorActionPreference = "Stop"

function Assert-CodexSuccess {
  param([string]$Operation)
  if ($LASTEXITCODE -ne 0) {
    throw "Codex $Operation 失败，退出码：$LASTEXITCODE"
  }
}

if (-not $HttpsProxy) {
  $internetSettings = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction SilentlyContinue
  if ($internetSettings.ProxyEnable -eq 1 -and $internetSettings.ProxyServer) {
    $HttpsProxy = ($internetSettings.ProxyServer -split ";")[0]
  }
}
if ($HttpsProxy -and -not $HttpsProxy.StartsWith("http")) {
  $HttpsProxy = "http://$HttpsProxy"
}
if ($HttpsProxy) {
  $env:HTTPS_PROXY = $HttpsProxy
  $env:HTTP_PROXY = $HttpsProxy
}

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
  throw "未找到 codex 命令。请先安装并登录支持插件的 Codex。"
}

$marketplaces = codex plugin marketplace list 2>&1
Assert-CodexSuccess "marketplace list"
if ($marketplaces -match "(?m)^\s*$([regex]::Escape($Marketplace))\s") {
  codex plugin marketplace upgrade $Marketplace
  Assert-CodexSuccess "marketplace upgrade"
} else {
  if ($Ref) {
    codex plugin marketplace add $MarketplaceSource --ref $Ref
  } else {
    codex plugin marketplace add $MarketplaceSource
  }
  Assert-CodexSuccess "marketplace add"
}

codex plugin add $PluginId
Assert-CodexSuccess "plugin add"

Write-Host ""
Write-Host "Codex SSH 已安装。" -ForegroundColor Green
Write-Host "请重启 Codex 或新建会话，然后输入：列出 SSH 主机"
