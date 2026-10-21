#!/usr/bin/env bash
set -euo pipefail

MARKETPLACE_SOURCE="${MARKETPLACE_SOURCE:-skaduv/codex-ssh}"
MARKETPLACE_REF="${MARKETPLACE_REF:-main}"
MARKETPLACE_NAME="${MARKETPLACE_NAME:-codex-ssh}"
PLUGIN_ID="${PLUGIN_ID:-codex-ssh@codex-ssh}"

if ! command -v codex >/dev/null 2>&1; then
  echo "未找到 codex 命令。请先安装并登录支持插件的 Codex。" >&2
  exit 1
fi

if codex plugin marketplace list 2>/dev/null | grep -Eq "^[[:space:]]*${MARKETPLACE_NAME}[[:space:]]"; then
  codex plugin marketplace upgrade "$MARKETPLACE_NAME"
else
  if [[ -n "$MARKETPLACE_REF" ]]; then
    codex plugin marketplace add "$MARKETPLACE_SOURCE" --ref "$MARKETPLACE_REF"
  else
    codex plugin marketplace add "$MARKETPLACE_SOURCE"
  fi
fi

codex plugin add "$PLUGIN_ID"

printf '\nCodex SSH 已安装。\n请重启 Codex 或新建会话，然后输入：列出 SSH 主机\n'
