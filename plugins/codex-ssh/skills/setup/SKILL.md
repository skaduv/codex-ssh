---
name: codex-ssh-setup
description: Configure Codex SSH safely by creating a host aliases file without exposing passwords, private keys, or tokens in chat.
---

# Configure Codex SSH

Use this workflow when Codex SSH has no configured hosts, a connection fails, or
the user wants to add or remove a machine profile.

1. Call `ssh_list_hosts`. It includes the import state, plugin config path, and
   OpenSSH config path.
2. The MCP server imports concrete `~/.ssh/config` hosts automatically on first
   run. Do not recreate that config by hand when imported profiles already exist.
3. Add a host with `ssh_add_host` when the user asks for another machine. If the
   alias exists in `~/.ssh/config`, omit hostname and credentials so their
   OpenSSH settings are imported. Otherwise collect hostname, username, port,
   default directory, and authentication type.
   Use `displayName` when the user wants a Chinese or human-readable name. Keep
   the ASCII `alias` as the stable identifier for later tool calls.
4. Never ask the user to paste a password, passphrase, private key, or token into
   the conversation or a tool argument. Credentials may be stored directly in
   the local `~/.codex-ssh/servers.json`: use `auth.password`, `auth.passphrase`,
   or `auth.privateKey`, or use the compatible environment-variable fields. The
   MCP process reads these values internally. Tell the user to fill the secret
   locally after the profile is created; do not read or echo the file.
5. Use `hostKeyPolicy: "tofu"` by default. If the user supplies a verified
   `SHA256:` fingerprint, use `hostKeyPolicy: "pinned"` and set
   `hostFingerprint`.
6. Use `ssh_import_ssh_config` only for an explicit re-import or an empty plugin
   profile list. Existing profiles are preserved unless the user explicitly
   requests overwrite.
7. Remove a host with `ssh_remove_host` only when explicitly requested. Explain
   that this edits the plugin profile list, not `~/.ssh/config` or server access.
8. Call `ssh_test_connection` for a new or changed alias.
9. If it succeeds, run one explicitly read-only command such as `pwd` or
   `uname -a` to verify command execution, then report the alias and effective
   limits.

To change only a host's Chinese or human-readable name, call
`ssh_set_display_name`; do not remove and recreate the host.

Never print credential values. Never place `servers.json` or inline keys in the
plugin source directory or tool results. Explain that a running MCP process
reloads host settings when the file changes; if it uses an environment variable,
the Codex app may need a restart after that environment changes.
