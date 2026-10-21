param(
  [string]$MarketplaceSource = "skaduv/codex-ssh",
  [string]$Ref = "main",
  [string]$Marketplace = "codex-ssh",
  [string]$PluginId = "codex-ssh@codex-ssh"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
  throw "未找到 codex 命令。请先安装并登录支持插件的 Codex。"
}

$marketplaces = codex plugin marketplace list 2>&1
if ($marketplaces -match "(?m)^\s*$([regex]::Escape($Marketplace))\s") {
  codex plugin marketplace upgrade $Marketplace
} else {
  if ($Ref) {
    codex plugin marketplace add $MarketplaceSource --ref $Ref
  } else {
    codex plugin marketplace add $MarketplaceSource
  }
}

codex plugin add $PluginId

Write-Host ""
Write-Host "Codex SSH 已安装。" -ForegroundColor Green
Write-Host "请重启 Codex 或新建会话，然后输入：列出 SSH 主机"
