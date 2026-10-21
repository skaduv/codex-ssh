import { z } from "zod";
import { scheduleUninstall } from "../scripts/uninstall-lib.mjs";

function success(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function failure(error) {
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    isError: true,
  };
}

function guarded(operation) {
  return async (args) => {
    try {
      return success(await operation(args));
    } catch (error) {
      return failure(error);
    }
  };
}

const hostInput = z
  .string()
  .min(1)
  .describe("Configured SSH host alias returned by ssh_list_hosts.");

function publicHost(configStore, alias) {
  return configStore.listHosts().find((host) => host.alias === alias);
}

export function registerSshTools(server, configStore, sshManager) {
  server.registerTool(
    "ssh_list_hosts",
    {
      title: "List configured SSH hosts",
      description:
        "List SSH host aliases available to this plugin and show the local config file path. Call this before operating on a server. Secrets are never returned.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    guarded(async () => {
      const hosts = configStore.listHosts();
      return {
        ok: true,
        configPath: configStore.getConfigPath(),
        openSshConfigPath: configStore.getOpenSshConfigPath(),
        sshConfigImport: configStore.getImportState(),
        configExists: configStore.configExists,
        hosts,
        setupHint:
          hosts.length === 0
            ? `No profiles were imported or added. Configure ${configStore.getOpenSshConfigPath()} and call ssh_import_ssh_config, or use ssh_add_host.`
            : undefined,
      };
    })
  );

  server.registerTool(
    "ssh_import_ssh_config",
    {
      title: "Import hosts from OpenSSH config",
      description:
        "Read ~/.ssh/config, including concrete Host entries from common Include files, and add them to the plugin's managed host list. Existing plugin profiles are preserved unless overwrite=true. Wildcard-only Host patterns are not machine profiles and are skipped.",
      inputSchema: {
        overwrite: z
          .boolean()
          .default(false)
          .describe("Replace plugin profiles that already use the same alias."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    guarded(async ({ overwrite }) => ({
      ok: true,
      ...configStore.importOpenSshConfig({ overwrite }),
    }))
  );

  server.registerTool(
    "ssh_add_host",
    {
      title: "Add an SSH host profile",
      description:
        "Add a machine profile to the plugin config. If alias exists in ~/.ssh/config, host, user, port, and key/agent settings are imported automatically. Otherwise provide host and authentication settings. This writes only Codex SSH's servers.json and never writes ~/.ssh/config.",
      inputSchema: {
        alias: z
          .string()
          .min(1)
          .max(64)
          .describe("Short alias used by later SSH tools."),
        displayName: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe(
            "Optional human-readable name. Supports Chinese, spaces, and other Unicode characters."
          ),
        useSshConfig: z
          .boolean()
          .default(true)
          .describe("Import matching OpenSSH Host settings when available."),
        host: z
          .string()
          .min(1)
          .optional()
          .describe("Hostname or IP when no OpenSSH profile matches."),
        username: z.string().min(1).optional().describe("SSH username."),
        port: z.number().int().min(1).max(65_535).optional(),
        authType: z
          .enum(["privateKey", "password", "agent"])
          .optional()
          .describe("Authentication type for a manually defined host."),
        privateKeyPath: z
          .string()
          .min(1)
          .optional()
          .describe("Local private key path for privateKey authentication."),
        passphraseEnv: z
          .string()
          .min(1)
          .optional()
          .describe("Environment variable holding the private key passphrase."),
        passwordEnv: z
          .string()
          .min(1)
          .optional()
          .describe("Environment variable holding the password."),
        agentSocket: z
          .string()
          .min(1)
          .optional()
          .describe("SSH agent socket or Windows named pipe for agent auth."),
        defaultCwd: z
          .string()
          .min(1)
          .optional()
          .describe("Default remote working directory."),
        hostKeyPolicy: z
          .enum(["tofu", "pinned", "insecure"])
          .optional()
          .describe("Host key verification policy."),
        hostFingerprint: z
          .string()
          .min(1)
          .optional()
          .describe("Expected SHA256 host key fingerprint for pinned policy."),
        allowExec: z.boolean().optional(),
        allowWrite: z.boolean().optional(),
        overwrite: z
          .boolean()
          .default(false)
          .describe("Replace an existing plugin profile with the same alias."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (profile) => {
      configStore.addHost(profile.alias, profile);
      return {
        ok: true,
        host: publicHost(configStore, profile.alias),
        configPath: configStore.getConfigPath(),
      };
    })
  );

  server.registerTool(
    "ssh_set_display_name",
    {
      title: "Set a host display name",
      description:
        "Set or change the human-readable displayName for an existing SSH host alias. The stable alias and SSH connection settings are not changed. Chinese names are supported.",
      inputSchema: {
        alias: z
          .string()
          .min(1)
          .describe("Stable configured host alias to rename for display."),
        displayName: z
          .string()
          .min(1)
          .max(80)
          .describe(
            "Human-readable host name. Supports Chinese, spaces, and other Unicode characters."
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    guarded(async ({ alias, displayName }) => {
      configStore.setDisplayName(alias, displayName);
      return {
        ok: true,
        host: publicHost(configStore, alias),
        configPath: configStore.getConfigPath(),
      };
    })
  );

  server.registerTool(
    "ssh_remove_host",
    {
      title: "Remove an SSH host profile",
      description:
        "Remove a machine profile from Codex SSH's servers.json. This does not modify ~/.ssh/config or revoke any server access.",
      inputSchema: {
        alias: z
          .string()
          .min(1)
          .describe("Configured plugin alias to remove."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    guarded(async ({ alias }) => ({
      ok: true,
      ...configStore.removeHost(alias),
      configPath: configStore.getConfigPath(),
    }))
  );

  server.registerTool(
    "ssh_uninstall_plugin",
    {
      title: "Uninstall Codex SSH safely",
      description:
        "Schedule a detached uninstall of the installed Codex SSH plugin. The helper stops only plugin MCP processes that loaded this plugin's cache, calls the official Codex plugin removal command, retries Windows file-lock failures, and preserves host config unless deleteHostConfig=true. The current Codex SSH session will disconnect.",
      inputSchema: {
        confirm: z
          .boolean()
          .describe("Must be true after the user explicitly requests uninstall."),
        projectRoot: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Current Codex project root. Used to remove only this plugin's project activation sections."
          ),
        deleteHostConfig: z
          .boolean()
          .default(false)
          .describe(
            "Also delete ~/.codex-ssh, including servers.json and known-host records."
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    guarded(async ({ confirm, projectRoot, deleteHostConfig }) => {
      if (confirm !== true) {
        throw new Error(
          "confirm=true is required for plugin uninstall."
        );
      }
      return {
        ok: true,
        ...scheduleUninstall({
          pluginRoot: process.env.PLUGIN_ROOT || process.cwd(),
          projectRoot,
          deleteHostConfig,
        }),
      };
    })
  );

  server.registerTool(
    "ssh_test_connection",
    {
      title: "Test an SSH connection",
      description:
        "Open an SSH connection to a configured host and verify that SFTP is available. This does not run a shell command.",
      inputSchema: {
        host: hostInput,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    guarded(async ({ host }) => ({
      ok: true,
      host,
      ...(await sshManager.testConnection(host)),
    }))
  );

  server.registerTool(
    "ssh_exec",
    {
      title: "Run a shell command over SSH",
      description:
        "Run a shell command on a configured SSH host. The command runs through the remote POSIX shell, optionally from a working directory. Output is bounded. Non-zero exit codes are returned as data, not tool failures.",
      inputSchema: {
        host: hostInput,
        command: z
          .string()
          .min(1)
          .max(65_536)
          .describe("Shell command to run on the remote server."),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Remote working directory. Defaults to the host's defaultCwd, or the login directory."
          ),
        timeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(600_000)
          .optional()
          .describe("Command timeout in milliseconds."),
        maxOutputBytes: z
          .number()
          .int()
          .min(1_024)
          .max(4 * 1024 * 1024)
          .optional()
          .describe("Maximum bytes retained for each of stdout and stderr."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    guarded(async ({ host, command, cwd, timeoutMs, maxOutputBytes }) => ({
      ok: true,
      ...(await sshManager.exec(host, command, {
        cwd,
        timeoutMs,
        maxOutputBytes,
      })),
    }))
  );

  server.registerTool(
    "ssh_list_directory",
    {
      title: "List a remote directory",
      description:
        "List files and directories over SFTP on a configured SSH host.",
      inputSchema: {
        host: hostInput,
        path: z
          .string()
          .min(1)
          .default(".")
          .describe("Remote directory path. Relative paths are resolved by the SSH server."),
        maxEntries: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Maximum entries to return."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    guarded(async ({ host, path, maxEntries }) => ({
      ok: true,
      ...(await sshManager.listDirectory(host, path, { maxEntries })),
    }))
  );

  server.registerTool(
    "ssh_read_file",
    {
      title: "Read a remote file",
      description:
        "Read a bounded remote file over SFTP as UTF-8 text or base64 data. Large files are rejected rather than silently truncated.",
      inputSchema: {
        host: hostInput,
        path: z.string().min(1).describe("Remote file path."),
        encoding: z
          .enum(["utf8", "base64"])
          .default("utf8")
          .describe("Return UTF-8 text or base64-encoded binary data."),
        maxBytes: z
          .number()
          .int()
          .min(1_024)
          .max(64 * 1024 * 1024)
          .optional()
          .describe("Maximum file size to read. Cannot exceed the host limit."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    guarded(async ({ host, path, encoding, maxBytes }) => ({
      ok: true,
      ...(await sshManager.readFile(host, path, { encoding, maxBytes })),
    }))
  );

  server.registerTool(
    "ssh_write_file",
    {
      title: "Write a remote file",
      description:
        "Write UTF-8 text to a remote file over SFTP. Existing files are protected unless overwrite is explicitly true. The write uses a temporary file and preserves existing POSIX permissions when possible.",
      inputSchema: {
        host: hostInput,
        path: z.string().min(1).describe("Remote file path."),
        content: z.string().describe("UTF-8 content to write."),
        overwrite: z
          .boolean()
          .default(false)
          .describe("Allow replacing an existing file."),
        createDirectories: z
          .boolean()
          .default(true)
          .describe("Create missing parent directories."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    guarded(async ({ host, path, content, overwrite, createDirectories }) => ({
      ok: true,
      ...(await sshManager.writeFile(host, path, content, {
        overwrite,
        createDirectories,
      })),
    }))
  );

  server.registerTool(
    "ssh_upload_file",
    {
      title: "Upload a local file",
      description:
        "Upload one local regular file to a configured SSH host over SFTP. localPath must be absolute. Existing remote files are protected unless overwrite is true.",
      inputSchema: {
        host: hostInput,
        localPath: z
          .string()
          .min(1)
          .describe("Absolute path to the local source file."),
        remotePath: z.string().min(1).describe("Remote destination file path."),
        overwrite: z
          .boolean()
          .default(false)
          .describe("Allow replacing an existing remote file."),
        createDirectories: z
          .boolean()
          .default(true)
          .describe("Create missing remote parent directories."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    guarded(
      async ({ host, localPath, remotePath, overwrite, createDirectories }) => ({
        ok: true,
        ...(await sshManager.uploadFile(host, localPath, remotePath, {
          overwrite,
          createDirectories,
        })),
      })
    )
  );

  server.registerTool(
    "ssh_download_file",
    {
      title: "Download a remote file",
      description:
        "Download one remote regular file to an absolute local path over SFTP. Existing local files are protected unless overwrite is true.",
      inputSchema: {
        host: hostInput,
        remotePath: z.string().min(1).describe("Remote source file path."),
        localPath: z
          .string()
          .min(1)
          .describe("Absolute local destination file path."),
        overwrite: z
          .boolean()
          .default(false)
          .describe("Allow replacing an existing local file."),
        createDirectories: z
          .boolean()
          .default(true)
          .describe("Create missing local parent directories."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    guarded(
      async ({ host, remotePath, localPath, overwrite, createDirectories }) => ({
        ok: true,
        ...(await sshManager.downloadFile(host, remotePath, localPath, {
          overwrite,
          createDirectories,
        })),
      })
    )
  );
}
