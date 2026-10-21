import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./config-path.js";

const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const MAX_INCLUDE_DEPTH = 8;

export function defaultOpenSshConfigPath(env = process.env) {
  return path.resolve(
    expandHome(env.CODEX_SSH_OPENSSH_CONFIG ?? "~/.ssh/config")
  );
}

function tokenizeConfigLine(line) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;

  for (const character of line) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === "#" && token.length === 0) {
      break;
    }

    if (/\s/u.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }

    token += character;
  }

  if (escaped) {
    token += "\\";
  }
  if (token) {
    tokens.push(token);
  }

  if (tokens.length === 0) {
    return null;
  }

  return {
    keyword: tokens[0].toLowerCase(),
    values: tokens.slice(1),
  };
}

function wildcardToRegExp(pattern) {
  let expression = "^";
  for (const character of pattern) {
    if (character === "*") {
      expression += ".*";
    } else if (character === "?") {
      expression += ".";
    } else {
      expression += character.replace(/[\\^$.[\]{}()+|]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u");
}

function expandIncludePatterns(pattern, baseDirectory) {
  const expanded = expandHome(pattern);
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(baseDirectory, expanded);

  if (!/[*?]/u.test(absolute)) {
    return fs.existsSync(absolute) ? [absolute] : [];
  }

  const parsed = path.parse(absolute);
  const relative = absolute.slice(parsed.root.length);
  const segments = relative.split(/[\\/]/u).filter(Boolean);
  const matches = [];

  function walk(directory, index) {
    if (index >= segments.length) {
      if (fs.existsSync(directory) && fs.statSync(directory).isFile()) {
        matches.push(directory);
      }
      return;
    }

    const segment = segments[index];
    if (!/[*?]/u.test(segment)) {
      walk(path.join(directory, segment), index + 1);
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const matcher = wildcardToRegExp(segment);
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (!matcher.test(entry.name)) {
        continue;
      }
      const next = path.join(directory, entry.name);
      if (index === segments.length - 1) {
        if (entry.isFile()) {
          matches.push(next);
        }
      } else if (entry.isDirectory()) {
        walk(next, index + 1);
      }
    }
  }

  walk(parsed.root, 0);
  return matches;
}

export function discoverOpenSshAliases(configPath, warnings = []) {
  const aliases = new Set();
  const visited = new Set();

  function readConfig(filePath, depth) {
    if (depth > MAX_INCLUDE_DEPTH) {
      warnings.push(`Include depth exceeded at ${filePath}.`);
      return;
    }

    let resolvedPath;
    try {
      resolvedPath = fs.realpathSync(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        warnings.push(`Cannot read ${filePath}: ${error.message}`);
      }
      return;
    }

    if (visited.has(resolvedPath)) {
      return;
    }
    visited.add(resolvedPath);

    let source;
    try {
      source = fs.readFileSync(resolvedPath, "utf8");
    } catch (error) {
      warnings.push(`Cannot read ${resolvedPath}: ${error.message}`);
      return;
    }

    const baseDirectory = path.dirname(resolvedPath);
    for (const line of source.split(/\r?\n/u)) {
      const parsed = tokenizeConfigLine(line.trimStart());
      if (!parsed) {
        continue;
      }

      if (parsed.keyword === "host") {
        for (const pattern of parsed.values) {
          if (ALIAS_PATTERN.test(pattern) && !pattern.startsWith("-")) {
            aliases.add(pattern);
          }
        }
        continue;
      }

      if (parsed.keyword === "include") {
        for (const pattern of parsed.values) {
          for (const includedPath of expandIncludePatterns(
            pattern,
            baseDirectory
          )) {
            readConfig(includedPath, depth + 1);
          }
        }
      }
    }
  }

  if (!fs.existsSync(configPath)) {
    return {
      aliases: [],
      configExists: false,
      warnings,
    };
  }

  readConfig(configPath, 0);
  return {
    aliases: [...aliases].sort((left, right) => left.localeCompare(right)),
    configExists: true,
    warnings,
  };
}

function parseSshGOutput(output) {
  const options = {
    identityFiles: [],
  };

  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf(" ");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "identityfile") {
      if (value && value !== "none") {
        options.identityFiles.push(value);
      }
      continue;
    }

    if (
      [
        "hostname",
        "user",
        "port",
        "identityagent",
        "proxyjump",
        "proxycommand",
        "certificatefile",
        "connecttimeout",
      ].includes(key) &&
      options[key] === undefined
    ) {
      options[key] = value;
    }
  }

  return options;
}

export function resolveOpenSshHost(alias, configPath, env = process.env) {
  const sshBinary = env.CODEX_SSH_SSH_BIN || "ssh";
  const output = execFileSync(
    sshBinary,
    ["-G", "-F", configPath, alias],
    {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        LC_ALL: "C",
      },
    }
  );
  return parseSshGOutput(output);
}

function normalizeIdentityPath(value) {
  return expandHome(
    value
      .replaceAll("%d", os.homedir())
      .replaceAll("%u", os.userInfo().username)
  );
}

export function buildImportedHost({
  alias,
  sshConfigPath,
  resolved,
  importedAt,
}) {
  const warnings = [];
  const identityPath = resolved.identityFiles
    .map(normalizeIdentityPath)
    .find(Boolean);

  let auth;
  if (identityPath) {
    auth = {
      type: "privateKey",
      privateKeyPath: identityPath,
    };
  } else {
    auth = {
      type: "agent",
      agentSocket:
        resolved.identityagent &&
        resolved.identityagent !== "SSH_AUTH_SOCK" &&
        resolved.identityagent !== "none"
          ? normalizeIdentityPath(resolved.identityagent)
          : undefined,
    };
  }

  if (resolved.proxyjump && resolved.proxyjump !== "none") {
    warnings.push(
      `ProxyJump "${resolved.proxyjump}" is present in OpenSSH config but is not applied by the ssh2 connection backend.`
    );
  }
  if (resolved.proxycommand && resolved.proxycommand !== "none") {
    warnings.push(
      "ProxyCommand is present in OpenSSH config but is not applied by the ssh2 connection backend."
    );
  }
  if (resolved.certificatefile && resolved.certificatefile !== "none") {
    warnings.push(
      "CertificateFile is present in OpenSSH config but certificate authentication is not applied by the ssh2 connection backend."
    );
  }

  const parsedPort = Number.parseInt(resolved.port || "22", 10);
  const port =
    Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535
      ? parsedPort
      : 22;

  return {
    host: resolved.hostname || alias,
    port,
    username: resolved.user || os.userInfo().username,
    auth,
    hostKeyPolicy: "tofu",
    connectTimeoutMs: Math.max(
      1_000,
      Math.min(
        120_000,
        (Number.parseInt(resolved.connecttimeout || "15", 10) || 15) * 1_000
      )
    ),
    source: "sshConfig",
    sshConfigAlias: alias,
    sshConfigPath,
    importedAt,
    importWarnings: warnings,
  };
}
