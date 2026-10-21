import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "ssh2";
import { expandHome } from "./config.js";
import { HostKeyStore } from "./host-key-store.js";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function withCwd(command, cwd) {
  if (!cwd) {
    return command;
  }
  return `cd -- ${shellQuote(cwd)} && ${command}`;
}

function appendChunk(buffers, chunk, state, limit) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.total += buffer.length;
  const remaining = limit - state.stored;

  if (remaining <= 0) {
    state.truncated = true;
    return;
  }

  if (buffer.length > remaining) {
    buffers.push(buffer.subarray(0, remaining));
    state.stored += remaining;
    state.truncated = true;
    return;
  }

  buffers.push(buffer);
  state.stored += buffer.length;
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, value) => {
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    });
  });
}

function isMissingError(error) {
  return (
    error?.code === 2 ||
    error?.code === "ENOENT" ||
    /no such file/i.test(error?.message ?? "")
  );
}

async function statOptional(sftp, remotePath) {
  try {
    return await sftpCall(sftp, "stat", remotePath);
  } catch (error) {
    if (isMissingError(error)) {
      return null;
    }
    throw error;
  }
}

async function ensureRemoteDirectory(sftp, remotePath) {
  const directory = path.posix.dirname(remotePath);
  if (!directory || directory === "." || directory === "/") {
    return;
  }

  const segments = directory.split("/").filter(Boolean);
  let current = directory.startsWith("/") ? "/" : "";

  for (const segment of segments) {
    current = current === "/" ? `/${segment}` : path.posix.join(current, segment);
    try {
      await sftpCall(sftp, "mkdir", current, { mode: 0o755 });
    } catch (error) {
      const existing = await statOptional(sftp, current);
      if (!existing?.isDirectory()) {
        throw new Error(`Cannot create remote directory ${current}: ${error.message}`);
      }
    }
  }
}

async function unlinkOptional(sftp, remotePath) {
  try {
    await sftpCall(sftp, "unlink", remotePath);
  } catch (error) {
    if (!isMissingError(error)) {
      throw error;
    }
  }
}

function validateRemotePath(remotePath) {
  if (
    typeof remotePath !== "string" ||
    !remotePath.trim() ||
    remotePath.includes("\0")
  ) {
    throw new Error("A non-empty remote path without NUL characters is required.");
  }
  return remotePath;
}

function validateLocalPath(localPath) {
  if (
    typeof localPath !== "string" ||
    !localPath.trim() ||
    localPath.includes("\0")
  ) {
    throw new Error("A non-empty local path without NUL characters is required.");
  }
  const expanded = expandHome(localPath);
  if (!path.isAbsolute(expanded)) {
    throw new Error("localPath must be an absolute path.");
  }
  return path.normalize(expanded);
}

function defaultAgentSocket() {
  if (process.env.SSH_AUTH_SOCK) {
    return process.env.SSH_AUTH_SOCK;
  }

  if (process.platform === "win32") {
    return "\\\\.\\pipe\\openssh-ssh-agent";
  }

  return undefined;
}

export class SshManager {
  constructor(configStore) {
    this.configStore = configStore;
    this.entries = new Map();
  }

  assertCommandAllowed(host, command) {
    if (!host.allowExec) {
      throw new Error(`Command execution is disabled for SSH host "${host.alias}".`);
    }

    if (typeof command !== "string" || !command.trim() || command.includes("\0")) {
      throw new Error("command must be a non-empty string without NUL characters.");
    }

    for (const pattern of host.commandPolicy.deniedPatterns) {
      if (pattern.test(command)) {
        throw new Error(
          `Command rejected by deniedPatterns for SSH host "${host.alias}".`
        );
      }
    }

    const allowed = host.commandPolicy.allowedPatterns;
    if (allowed.length > 0 && !allowed.some((pattern) => pattern.test(command))) {
      throw new Error(
        `Command does not match allowedPatterns for SSH host "${host.alias}".`
      );
    }
  }

  async createClient(host) {
    const client = new Client();
    let hostKeyError;
    const hostKeyStore = new HostKeyStore(host);
    const connection = {
      host: host.host,
      port: host.port,
      username: host.username,
      readyTimeout: host.connectTimeoutMs,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      hostVerifier: (rawKey) => {
        try {
          return hostKeyStore.verify(rawKey);
        } catch (error) {
          hostKeyError = error;
          return false;
        }
      },
    };

    let password;
    if (host.auth.type === "privateKey") {
      if (host.auth.privateKey) {
        connection.privateKey = Buffer.from(host.auth.privateKey);
      } else {
        try {
          connection.privateKey = fs.readFileSync(host.auth.privateKeyPath);
        } catch (error) {
          throw new Error(
            `Cannot read private key ${host.auth.privateKeyPath} for SSH host "${host.alias}": ${error.message}`
          );
        }
      }

      if (host.auth.passphrase || host.auth.passphraseEnv) {
        connection.passphrase =
          host.auth.passphrase ??
          process.env[host.auth.passphraseEnv];
        if (!connection.passphrase) {
          throw new Error(
            `Environment variable ${host.auth.passphraseEnv} is not set for SSH host "${host.alias}".`
          );
        }
      }
    } else if (host.auth.type === "password") {
      password =
        host.auth.password ??
        (host.auth.passwordEnv
          ? process.env[host.auth.passwordEnv]
          : undefined);
      if (!password) {
        throw new Error(
          host.auth.passwordEnv
            ? `Environment variable ${host.auth.passwordEnv} is not set for SSH host "${host.alias}".`
            : `No password is configured for SSH host "${host.alias}".`
        );
      }
      connection.password = password;
      connection.tryKeyboard = true;
    } else if (host.auth.type === "agent") {
      connection.agent = host.auth.agentSocket ?? defaultAgentSocket();
      if (!connection.agent) {
        throw new Error(
          `No SSH agent socket is configured for SSH host "${host.alias}".`
        );
      }
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (!settled) {
          settled = true;
          callback(value);
        }
      };

      client.once("ready", () => settle(resolve));
      client.once("error", (error) =>
        settle(reject, hostKeyError ?? error)
      );
      client.once("close", () => {
        if (!settled) {
          settle(
            reject,
            hostKeyError ??
              new Error("SSH connection closed before authentication completed.")
          );
        }
      });

      if (password) {
        client.once(
          "keyboard-interactive",
          (_name, _instructions, _language, prompts, finish) => {
            finish(prompts.map(() => password));
          }
        );
      }

      try {
        client.connect(connection);
      } catch (error) {
        settle(reject, hostKeyError ?? error);
      }
    }).catch((error) => {
      client.end();
      throw new Error(
        `SSH connection to "${host.alias}" failed: ${error.message}`
      );
    });

    return client;
  }

  async getClient(alias) {
    const host = this.configStore.getHost(alias);
    const current = this.entries.get(alias);

    if (current?.version === host.version) {
      return current.promise;
    }

    if (current) {
      this.close(alias);
    }

    const entry = {
      version: host.version,
      client: null,
      promise: null,
    };

    entry.promise = this.createClient(host).then((client) => {
      entry.client = client;
      client.once("close", () => {
        if (this.entries.get(alias) === entry) {
          this.entries.delete(alias);
        }
      });
      client.on("error", (error) => {
        console.error(`SSH connection error for ${alias}: ${error.message}`);
      });
      return client;
    });

    this.entries.set(alias, entry);

    try {
      return await entry.promise;
    } catch (error) {
      if (this.entries.get(alias) === entry) {
        this.entries.delete(alias);
      }
      throw error;
    }
  }

  close(alias) {
    const entry = this.entries.get(alias);
    if (!entry) {
      return;
    }
    this.entries.delete(alias);
    entry.client?.end();
  }

  closeAll() {
    for (const alias of [...this.entries.keys()]) {
      this.close(alias);
    }
  }

  async testConnection(alias) {
    const client = await this.getClient(alias);
    const sftp = await new Promise((resolve, reject) => {
      client.sftp((error, value) => {
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      });
    });
    sftp.end();
    return { connected: true, sftpAvailable: true };
  }

  async exec(alias, command, options = {}) {
    const host = this.configStore.getHost(alias);
    this.assertCommandAllowed(host, command);
    const client = await this.getClient(alias);
    const timeoutMs = Math.min(
      options.timeoutMs ?? host.commandTimeoutMs,
      host.commandTimeoutMs
    );
    const cwd = options.cwd ?? host.defaultCwd;
    const remoteCommand = withCwd(command, cwd);
    const startedAt = Date.now();

    const stream = await new Promise((resolve, reject) => {
      client.exec(remoteCommand, (error, value) => {
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      });
    });

    return new Promise((resolve, reject) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      const stdoutState = { stored: 0, total: 0, truncated: false };
      const stderrState = { stored: 0, total: 0, truncated: false };
      let timedOut = false;
      let settled = false;
      const limit = Math.min(
        options.maxOutputBytes ?? host.maxOutputBytes,
        host.maxOutputBytes
      );

      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        callback(value);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          stream.signal?.("KILL");
        } catch {
          // Closing the channel is the fallback.
        }
        stream.close();
        this.close(alias);
        finish(
          reject,
          new Error(
            `SSH command timed out after ${timeoutMs} ms on host "${alias}".`
          )
        );
      }, timeoutMs);

      stream.on("data", (chunk) => {
        appendChunk(stdoutChunks, chunk, stdoutState, limit);
      });
      stream.stderr.on("data", (chunk) => {
        appendChunk(stderrChunks, chunk, stderrState, limit);
      });
      stream.once("error", (error) => finish(reject, error));
      stream.once("close", (code, signal) => {
        if (timedOut) {
          return;
        }
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        finish(resolve, {
          host: alias,
          exitCode: typeof code === "number" ? code : null,
          signal: signal || null,
          stdout,
          stderr,
          stdoutBytes: stdoutState.total,
          stderrBytes: stderrState.total,
          truncated: stdoutState.truncated || stderrState.truncated,
          durationMs: Date.now() - startedAt,
          cwd: cwd ?? null,
          command,
        });
      });
    });
  }

  async withSftp(alias, operation) {
    const client = await this.getClient(alias);
    const sftp = await new Promise((resolve, reject) => {
      client.sftp((error, value) => {
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      });
    });

    try {
      return await operation(sftp);
    } finally {
      sftp.end();
    }
  }

  async listDirectory(alias, remotePath = ".", options = {}) {
    const host = this.configStore.getHost(alias);
    const validatedPath = validateRemotePath(remotePath);
    const maxEntries = Math.min(options.maxEntries ?? 500, 1_000);

    return this.withSftp(alias, async (sftp) => {
      const entries = await sftpCall(sftp, "readdir", validatedPath);
      const sorted = entries.sort((left, right) => {
        const leftDirectory = left.attrs.isDirectory() ? 0 : 1;
        const rightDirectory = right.attrs.isDirectory() ? 0 : 1;
        return leftDirectory - rightDirectory || left.filename.localeCompare(right.filename);
      });
      const visible = sorted.slice(0, maxEntries).map((entry) => ({
        name: entry.filename,
        type: entry.attrs.isDirectory()
          ? "directory"
          : entry.attrs.isSymbolicLink()
            ? "symlink"
            : "file",
        size: Number(entry.attrs.size),
        mode: entry.attrs.mode,
        modifiedAt:
          typeof entry.attrs.mtime === "number"
            ? new Date(entry.attrs.mtime * 1_000).toISOString()
            : null,
      }));

      return {
        host: alias,
        path: validatedPath,
        entries: visible,
        totalEntries: sorted.length,
        truncated: sorted.length > visible.length,
        limits: {
          maxEntries,
          maxFileBytes: host.maxFileBytes,
        },
      };
    });
  }

  async readRemoteFile(alias, remotePath, maxBytes) {
    const host = this.configStore.getHost(alias);
    const validatedPath = validateRemotePath(remotePath);
    const limit = Math.min(maxBytes ?? host.maxFileBytes, host.maxFileBytes);

    return this.withSftp(alias, async (sftp) => {
      const attributes = await sftpCall(sftp, "stat", validatedPath);
      if (attributes.isDirectory()) {
        throw new Error(`Remote path is a directory: ${validatedPath}`);
      }
      if (Number(attributes.size) > limit) {
        throw new Error(
          `Remote file is ${attributes.size} bytes, exceeding the ${limit}-byte read limit for host "${alias}".`
        );
      }
      const content = await sftpCall(sftp, "readFile", validatedPath);
      return {
        content,
        size: Number(attributes.size),
        mode: attributes.mode,
      };
    });
  }

  async readFile(alias, remotePath, options = {}) {
    const file = await this.readRemoteFile(alias, remotePath, options.maxBytes);
    const encoding = options.encoding ?? "utf8";
    return {
      host: alias,
      path: remotePath,
      encoding,
      size: file.size,
      mode: file.mode,
      content: file.content.toString(encoding),
    };
  }

  async writeFile(alias, remotePath, content, options = {}) {
    const host = this.configStore.getHost(alias);
    if (!host.allowWrite) {
      throw new Error(`File writes are disabled for SSH host "${host.alias}".`);
    }

    const validatedPath = validateRemotePath(remotePath);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (buffer.length > host.maxFileBytes) {
      throw new Error(
        `Content is ${buffer.length} bytes, exceeding the ${host.maxFileBytes}-byte write limit for host "${alias}".`
      );
    }

    return this.withSftp(alias, async (sftp) => {
      const existing = await statOptional(sftp, validatedPath);
      if (existing?.isDirectory()) {
        throw new Error(`Remote path is a directory: ${validatedPath}`);
      }
      if (existing && options.overwrite !== true) {
        throw new Error(
          `Remote file already exists: ${validatedPath}. Set overwrite=true to replace it.`
        );
      }

      if (options.createDirectories !== false) {
        await ensureRemoteDirectory(sftp, validatedPath);
      }

      const temporaryPath = path.posix.join(
        path.posix.dirname(validatedPath),
        `.${path.posix.basename(validatedPath)}.codex-ssh-${process.pid}-${crypto.randomUUID()}.tmp`
      );
      let temporaryWritten = false;

      try {
        await sftpCall(sftp, "writeFile", temporaryPath, buffer);
        temporaryWritten = true;

        if (existing && typeof existing.mode === "number") {
          await sftpCall(sftp, "chmod", temporaryPath, existing.mode & 0o777);
        }

        if (!existing) {
          await sftpCall(sftp, "rename", temporaryPath, validatedPath);
          temporaryWritten = false;
        } else {
          let renamed = false;
          if (typeof sftp.ext_openssh_rename === "function") {
            try {
              await sftpCall(
                sftp,
                "ext_openssh_rename",
                temporaryPath,
                validatedPath
              );
              temporaryWritten = false;
              renamed = true;
            } catch {
              // Fall back to the portable backup-and-rename sequence.
            }
          }

          if (!renamed) {
            const backupPath = path.posix.join(
              path.posix.dirname(validatedPath),
              `.${path.posix.basename(validatedPath)}.codex-ssh-backup-${crypto.randomUUID()}`
            );
            await sftpCall(sftp, "rename", validatedPath, backupPath);
            try {
              await sftpCall(sftp, "rename", temporaryPath, validatedPath);
              temporaryWritten = false;
            } catch (error) {
              await sftpCall(sftp, "rename", backupPath, validatedPath).catch(
                () => {}
              );
              throw error;
            }
            await unlinkOptional(sftp, backupPath);
          }
        }

        return {
          host: alias,
          path: validatedPath,
          bytesWritten: buffer.length,
          overwritten: Boolean(existing),
        };
      } finally {
        if (temporaryWritten) {
          await unlinkOptional(sftp, temporaryPath).catch(() => {});
        }
      }
    });
  }

  async uploadFile(alias, localPath, remotePath, options = {}) {
    const sourcePath = validateLocalPath(localPath);
    const host = this.configStore.getHost(alias);
    const attributes = await fs.promises.stat(sourcePath);
    if (!attributes.isFile()) {
      throw new Error(`Local path is not a regular file: ${sourcePath}`);
    }
    if (attributes.size > host.maxFileBytes) {
      throw new Error(
        `Local file is ${attributes.size} bytes, exceeding the ${host.maxFileBytes}-byte transfer limit for host "${alias}".`
      );
    }
    const content = await fs.promises.readFile(sourcePath);
    const written = await this.writeFile(alias, remotePath, content, options);
    return {
      ...written,
      localPath: sourcePath,
      direction: "upload",
    };
  }

  async downloadFile(alias, remotePath, localPath, options = {}) {
    const destinationPath = validateLocalPath(localPath);
    const file = await this.readRemoteFile(alias, remotePath);
    let destinationExists = false;

    try {
      const existing = await fs.promises.stat(destinationPath);
      destinationExists = true;
      if (!existing.isFile()) {
        throw new Error(`Local destination is not a regular file: ${destinationPath}`);
      }
      if (options.overwrite !== true) {
        throw new Error(
          `Local file already exists: ${destinationPath}. Set overwrite=true to replace it.`
        );
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    if (options.createDirectories !== false) {
      await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    }

    const temporaryPath = path.join(
      path.dirname(destinationPath),
      `.${path.basename(destinationPath)}.codex-ssh-${process.pid}-${crypto.randomUUID()}.tmp`
    );
    let backupPath;

    try {
      await fs.promises.writeFile(temporaryPath, file.content, {
        mode: process.platform === "win32" ? undefined : file.mode & 0o777,
      });

      if (process.platform !== "win32" && typeof file.mode === "number") {
        await fs.promises.chmod(temporaryPath, file.mode & 0o777);
      }

      if (destinationExists) {
        backupPath = path.join(
          path.dirname(destinationPath),
          `.${path.basename(destinationPath)}.codex-ssh-backup-${crypto.randomUUID()}`
        );
        await fs.promises.rename(destinationPath, backupPath);
      }
      try {
        await fs.promises.rename(temporaryPath, destinationPath);
      } catch (error) {
        if (backupPath) {
          await fs.promises.rename(backupPath, destinationPath).catch(() => {});
        }
        throw error;
      }
      if (backupPath) {
        await fs.promises.unlink(backupPath).catch(() => {});
      }
    } catch (error) {
      await fs.promises.unlink(temporaryPath).catch(() => {});
      throw error;
    }

    return {
      host: alias,
      remotePath,
      localPath: destinationPath,
      bytesWritten: file.size,
      overwritten: destinationExists,
      direction: "download",
      mode: file.mode,
    };
  }
}
