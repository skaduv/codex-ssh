---
name: codex-ssh-uninstall
description: Safely uninstall the Codex SSH plugin without Windows cache lock failures, while preserving host configuration unless explicitly requested otherwise.
---

# Uninstall Codex SSH

Use this workflow only when the user explicitly asks to uninstall, remove, or
disable Codex SSH.

1. Confirm whether the user also wants to delete
   `~/.codex-ssh/servers.json` and known-host records. Keep them by default.
2. Call `ssh_uninstall_plugin` with:
   - `confirm: true`
   - `projectRoot`: the current Codex workspace root
   - `deleteHostConfig`: true only when explicitly requested
3. The tool schedules a detached helper. The helper stops Codex SSH MCP
   processes that loaded the plugin cache, invokes the official
   `codex plugin remove` command, retries Windows file-lock failures, and
   removes only this plugin's project activation sections.
4. Report the returned log path. The current Codex SSH session will disconnect;
   do not retry the same uninstall or kill unrelated Node processes.
5. After the helper exits, verify with `codex plugin list`. The plugin should
   show `not installed`.

If the MCP tool is unavailable, run the packaged script from the current project
root:

```powershell
node <codex-ssh-plugin-root>/scripts/uninstall.mjs --project-root <current-project-root>
```

Do not manually delete the plugin cache while Codex SSH native modules may still
be loaded. Do not delete the plugin source directory or host config unless the
user separately confirms those destructive actions.
