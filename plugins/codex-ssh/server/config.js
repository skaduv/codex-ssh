import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./config-path.js";
import {
  buildImportedHost,
  defaultOpenSshConfigPath,
  discoverOpenSshAliases,
  resolveOpenSshHost,
} from "./openssh-config.js";

export { expandHome } from "./config-path.js";

const DEFAULT_LIMITS = {
  connectTimeoutMs: 15_000,
  commandTimeoutMs: 60_000,
  maxOutputBytes: 256 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
};

export function defaultConfigPath(env = process.env) {
  if (env.CODEX_SSH_CONFIG) {
    return path.resolve(expandHome(env.CODEX_SSH_CONFIG));
  }

  return path.join(os.homedir(), ".codex-ssh", "servers.json");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function requireString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function normalizeDisplayName(value, label) {
  if (value === undefined) {
    return undefined;
  }

  const displayName = requireString(value, label).trim();
  if (/[\u0000-\u001f\u007f]/u.test(displayName)) {
    throw new Error(`${label} cannot contain control characters.`);
  }
  if ([...displayName].length > 80) {
    throw new Error(`${label} must be 80 characters or fewer.`);
  }
  return displayName;
}

function boundedInteger(value, fallback, label, min, max) {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }

  return value;
}

function compilePatterns(value, label) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of regular expression strings.`);
  }

  return value.map((pattern, index) => {
    const source = requireString(pattern, `${label}[${index}]`);
    try {
      return new RegExp(source);
    } catch (error) {
      throw new Error(`${label}[${index}] is not a valid regular expression: ${error.message}`);
    }
  });
}

function normalizeAuth(raw, alias) {
  const auth = requireObject(raw, `hosts.${alias}.auth`);
  const type = requireString(auth.type, `hosts.${alias}.auth.type`);

  if (type === "privateKey") {
    const privateKey =
      auth.privateKey === undefined
        ? undefined
        : requireString(auth.privateKey, `hosts.${alias}.auth.privateKey`);
    const privateKeyPath =
      auth.privateKeyPath === undefined
        ? undefined
        : expandHome(
            requireString(
              auth.privateKeyPath,
              `hosts.${alias}.auth.privateKeyPath`
            )
          );
    if (!privateKey && !privateKeyPath) {
      throw new Error(
        `hosts.${alias}.auth requires privateKey or privateKeyPath when type is privateKey.`
      );
    }

    return {
      type,
      privateKey,
      privateKeyPath,
      passphrase:
        auth.passphrase === undefined
          ? undefined
          : requireString(auth.passphrase, `hosts.${alias}.auth.passphrase`),
      passphraseEnv:
        auth.passphraseEnv === undefined
          ? undefined
          : requireString(auth.passphraseEnv, `hosts.${alias}.auth.passphraseEnv`),
    };
  }

  if (type === "password") {
    const password =
      auth.password === undefined
        ? undefined
        : requireString(auth.password, `hosts.${alias}.auth.password`);
    const passwordEnv =
      auth.passwordEnv === undefined
        ? undefined
        : requireString(auth.passwordEnv, `hosts.${alias}.auth.passwordEnv`);
    if (!password && !passwordEnv) {
      throw new Error(
        `hosts.${alias}.auth requires password or passwordEnv when type is password.`
      );
    }

    return {
      type,
      password,
      passwordEnv,
    };
  }

  if (type === "agent") {
    return {
      type,
      agentSocket:
        auth.agentSocket === undefined
          ? undefined
          : expandHome(
              requireString(auth.agentSocket, `hosts.${alias}.auth.agentSocket`)
            ),
    };
  }

  throw new Error(
    `hosts.${alias}.auth.type must be one of: privateKey, password, agent.`
  );
}

function normalizeHost(alias, raw, configPath) {
  const host = requireObject(raw, `hosts.${alias}`);
  const hostKeyPolicy = host.hostKeyPolicy ?? "tofu";

  if (!["tofu", "pinned", "insecure"].includes(hostKeyPolicy)) {
    throw new Error(
      `hosts.${alias}.hostKeyPolicy must be one of: tofu, pinned, insecure.`
    );
  }

  const hostFingerprint =
    host.hostFingerprint === undefined
      ? undefined
      : requireString(host.hostFingerprint, `hosts.${alias}.hostFingerprint`);

  if (hostKeyPolicy === "pinned" && !hostFingerprint) {
    throw new Error(
      `hosts.${alias}.hostFingerprint is required when hostKeyPolicy is pinned.`
    );
  }

  const commandPolicyRaw =
    host.commandPolicy === undefined
      ? {}
      : requireObject(host.commandPolicy, `hosts.${alias}.commandPolicy`);

  return {
    alias,
    displayName: normalizeDisplayName(
      host.displayName,
      `hosts.${alias}.displayName`
    ),
    host: requireString(host.host, `hosts.${alias}.host`),
    port: boundedInteger(host.port, 22, `hosts.${alias}.port`, 1, 65_535),
    username: requireString(host.username, `hosts.${alias}.username`),
    auth: normalizeAuth(host.auth, alias),
    source: host.source === "sshConfig" ? "sshConfig" : "manual",
    sshConfigAlias:
      host.sshConfigAlias === undefined
        ? undefined
        : requireString(host.sshConfigAlias, `hosts.${alias}.sshConfigAlias`),
    sshConfigPath:
      host.sshConfigPath === undefined
        ? undefined
        : requireString(host.sshConfigPath, `hosts.${alias}.sshConfigPath`),
    importedAt:
      host.importedAt === undefined
        ? undefined
        : requireString(host.importedAt, `hosts.${alias}.importedAt`),
    importWarnings: Array.isArray(host.importWarnings)
      ? host.importWarnings.map((warning, index) =>
          requireString(
            warning,
            `hosts.${alias}.importWarnings[${index}]`
          )
        )
      : [],
    hostKeyPolicy,
    hostFingerprint,
    knownHostsPath: path.join(path.dirname(configPath), "known_hosts.json"),
    defaultCwd:
      host.defaultCwd === undefined
        ? undefined
        : requireString(host.defaultCwd, `hosts.${alias}.defaultCwd`),
    allowExec: host.allowExec !== false,
    allowWrite: host.allowWrite !== false,
    commandPolicy: {
      allowedPatterns: compilePatterns(
        commandPolicyRaw.allowedPatterns,
        `hosts.${alias}.commandPolicy.allowedPatterns`
      ),
      deniedPatterns: compilePatterns(
        commandPolicyRaw.deniedPatterns,
        `hosts.${alias}.commandPolicy.deniedPatterns`
      ),
    },
    connectTimeoutMs: boundedInteger(
      host.connectTimeoutMs,
      DEFAULT_LIMITS.connectTimeoutMs,
      `hosts.${alias}.connectTimeoutMs`,
      1_000,
      120_000
    ),
    commandTimeoutMs: boundedInteger(
      host.commandTimeoutMs,
      DEFAULT_LIMITS.commandTimeoutMs,
      `hosts.${alias}.commandTimeoutMs`,
      1_000,
      600_000
    ),
    maxOutputBytes: boundedInteger(
      host.maxOutputBytes,
      DEFAULT_LIMITS.maxOutputBytes,
      `hosts.${alias}.maxOutputBytes`,
      1_024,
      4 * 1024 * 1024
    ),
    maxFileBytes: boundedInteger(
      host.maxFileBytes,
      DEFAULT_LIMITS.maxFileBytes,
      `hosts.${alias}.maxFileBytes`,
      1_024,
      64 * 1024 * 1024
    ),
  };
}

function parseConfig(raw, configPath) {
  const root = requireObject(raw, "SSH config");
  const hostsRaw = requireObject(root.hosts ?? {}, "SSH config hosts");
  const hosts = {};

  for (const [alias, value] of Object.entries(hostsRaw)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(alias)) {
      throw new Error(
        `Host alias "${alias}" must contain only letters, numbers, dots, underscores, and hyphens (maximum 64 characters).`
      );
    }
    hosts[alias] = normalizeHost(alias, value, configPath);
  }

  return hosts;
}

function validateAlias(alias) {
  if (
    typeof alias !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(alias)
  ) {
    throw new Error(
      "Host alias must start with a letter or number and contain only letters, numbers, dots, underscores, and hyphens (maximum 64 characters)."
    );
  }
  return alias;
}

function emptyRawConfig() {
  return {
    version: 2,
    hosts: {},
    imports: {},
  };
}

function buildAuthFromProfile(profile) {
  const authType =
    profile.authType ??
    (profile.privateKeyPath
      ? "privateKey"
      : profile.password || profile.passwordEnv
        ? "password"
        : "agent");

  let auth;
  if (authType === "privateKey") {
    auth = {
      type: "privateKey",
      privateKeyPath: profile.privateKeyPath,
      passphraseEnv: profile.passphraseEnv,
    };
  } else if (authType === "password") {
    auth = {
      type: "password",
      password: profile.password,
      passwordEnv: profile.passwordEnv,
    };
  } else {
    auth = {
      type: "agent",
      agentSocket: profile.agentSocket,
    };
  }

  return auth;
}

function buildManualHost(alias, profile) {
  return {
    displayName: profile.displayName,
    host: profile.host,
    port: profile.port ?? 22,
    username: profile.username ?? os.userInfo().username,
    auth: buildAuthFromProfile(profile),
    hostKeyPolicy: profile.hostKeyPolicy ?? "tofu",
    hostFingerprint: profile.hostFingerprint,
    defaultCwd: profile.defaultCwd,
    allowExec: profile.allowExec,
    allowWrite: profile.allowWrite,
    source: "manual",
    importedAt: new Date().toISOString(),
  };
}

export class ConfigStore {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.configPath = defaultConfigPath(env);
    this.openSshConfigPath = defaultOpenSshConfigPath(env);
    this.autoImport = env.CODEX_SSH_AUTO_IMPORT !== "false";
    this.version = 0;
    this.lastSignature = undefined;
    this.hosts = {};
    this.raw = emptyRawConfig();
    this.configExists = false;
    this.loadError = null;

    if (this.autoImport) {
      this.importOpenSshConfig({ automatic: true });
    } else {
      this.reload(true);
    }
  }

  signature() {
    try {
      const stat = fs.statSync(this.configPath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      if (error.code === "ENOENT") {
        return "missing";
      }
      throw error;
    }
  }

  readRawConfig() {
    if (!fs.existsSync(this.configPath)) {
      return emptyRawConfig();
    }
    const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    const root = requireObject(parsed, "SSH config");
    requireObject(root.hosts ?? {}, "SSH config hosts");
    return root;
  }

  writeRawConfig(raw) {
    parseConfig(raw, this.configPath);
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const temporaryPath = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(raw, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      fs.renameSync(temporaryPath, this.configPath);
    } catch (error) {
      fs.unlinkSync(temporaryPath);
      throw new Error(
        `Cannot update SSH config at ${this.configPath}: ${error.message}`
      );
    }
    if (process.platform !== "win32") {
      fs.chmodSync(this.configPath, 0o600);
    }
    this.lastSignature = undefined;
  }

  reload(force = false) {
    let signature;
    try {
      signature = this.signature();
    } catch (error) {
      this.loadError = `Cannot read SSH config at ${this.configPath}: ${error.message}`;
      throw new Error(this.loadError);
    }

    if (!force && signature === this.lastSignature) {
      if (this.loadError) {
        throw new Error(this.loadError);
      }
      return;
    }

    this.lastSignature = signature;
    this.version += 1;
    this.loadError = null;

    if (signature === "missing") {
      this.configExists = false;
      this.hosts = {};
      this.raw = emptyRawConfig();
      return;
    }

    try {
      const source = fs.readFileSync(this.configPath, "utf8");
      const parsed = JSON.parse(source);
      this.hosts = parseConfig(parsed, this.configPath);
      this.raw = parsed;
      this.configExists = true;
    } catch (error) {
      this.hosts = {};
      this.raw = emptyRawConfig();
      this.configExists = true;
      this.loadError = `Invalid SSH config at ${this.configPath}: ${error.message}`;
      throw new Error(this.loadError);
    }
  }

  importOpenSshConfig({ overwrite = false, automatic = false } = {}) {
    if (!fs.existsSync(this.configPath)) {
      this.writeRawConfig(emptyRawConfig());
    }

    const raw = this.readRawConfig();
    raw.hosts ??= {};
    raw.imports ??= {};

    if (automatic && raw.imports.sshConfig?.importedAt) {
      this.reload(true);
      return {
        skipped: true,
        reason: "OpenSSH config was already imported once.",
        importState: raw.imports.sshConfig,
      };
    }

    const importedAt = new Date().toISOString();
    const warnings = [];
    const discovery = discoverOpenSshAliases(this.openSshConfigPath, warnings);

    if (!discovery.configExists) {
      const importState = {
        path: this.openSshConfigPath,
        attemptedAt: importedAt,
        configExists: false,
        importedCount: 0,
        skippedCount: 0,
        warnings: [`OpenSSH config not found: ${this.openSshConfigPath}`],
      };
      raw.imports.sshConfig = importState;
      this.writeRawConfig(raw);
      this.reload(true);
      return importState;
    }

    const importedAliases = [];
    const skippedAliases = [];

    for (const alias of discovery.aliases) {
      if (raw.hosts[alias] && !overwrite) {
        skippedAliases.push(alias);
        continue;
      }

      let resolved;
      try {
        resolved = resolveOpenSshHost(
          alias,
          this.openSshConfigPath,
          this.env
        );
      } catch (error) {
        warnings.push(
          `Could not resolve ${alias} with ssh -G; imported basic settings: ${error.message}`
        );
        resolved = {
          hostname: alias,
          user: os.userInfo().username,
          port: "22",
          identityFiles: [],
          connecttimeout: "15",
        };
      }

      try {
        const importedHost = buildImportedHost({
          alias,
          sshConfigPath: this.openSshConfigPath,
          resolved,
          importedAt,
        });
        normalizeHost(alias, importedHost, this.configPath);
        raw.hosts[alias] = importedHost;
        importedAliases.push(alias);
      } catch (error) {
        warnings.push(`Skipped ${alias}: ${error.message}`);
      }
    }

    const importState = {
      path: this.openSshConfigPath,
      attemptedAt: importedAt,
      importedAt,
      configExists: true,
      discoveredCount: discovery.aliases.length,
      importedCount: importedAliases.length,
      skippedCount: skippedAliases.length,
      importedAliases,
      skippedAliases,
      warnings: [...discovery.warnings, ...warnings],
    };
    raw.imports.sshConfig = importState;
    this.writeRawConfig(raw);
    this.reload(true);
    return importState;
  }

  addHost(alias, profile = {}) {
    validateAlias(alias);
    this.reload(true);
    const raw = this.readRawConfig();
    raw.hosts ??= {};
    raw.imports ??= {};

    if (raw.hosts[alias] && profile.overwrite !== true) {
      throw new Error(
        `SSH host alias "${alias}" already exists. Set overwrite=true to replace it.`
      );
    }

    let hostDefinition;
    if (profile.useSshConfig !== false) {
      const discovery = discoverOpenSshAliases(this.openSshConfigPath);
      if (discovery.aliases.includes(alias)) {
        const resolved = resolveOpenSshHost(
          alias,
          this.openSshConfigPath,
          this.env
        );
        hostDefinition = buildImportedHost({
          alias,
          sshConfigPath: this.openSshConfigPath,
          resolved,
          importedAt: new Date().toISOString(),
        });
      }
    }

    if (!hostDefinition) {
      hostDefinition = buildManualHost(alias, profile);
    }

    if (profile.host !== undefined) {
      hostDefinition.host = profile.host;
    }
    if (profile.displayName !== undefined) {
      hostDefinition.displayName = profile.displayName;
    }
    if (profile.username !== undefined) {
      hostDefinition.username = profile.username;
    }
    if (profile.port !== undefined) {
      hostDefinition.port = profile.port;
    }
    if (profile.defaultCwd !== undefined) {
      hostDefinition.defaultCwd = profile.defaultCwd;
    }
    if (profile.allowExec !== undefined) {
      hostDefinition.allowExec = profile.allowExec;
    }
    if (profile.allowWrite !== undefined) {
      hostDefinition.allowWrite = profile.allowWrite;
    }
    if (profile.hostKeyPolicy !== undefined) {
      hostDefinition.hostKeyPolicy = profile.hostKeyPolicy;
    }
    if (profile.hostFingerprint !== undefined) {
      hostDefinition.hostFingerprint = profile.hostFingerprint;
    }
    if (
      [
        "authType",
        "privateKeyPath",
        "passphraseEnv",
        "password",
        "passwordEnv",
        "agentSocket",
      ].some((key) => profile[key] !== undefined)
    ) {
      hostDefinition.auth = buildAuthFromProfile(profile);
    }

    raw.hosts[alias] = hostDefinition;
    this.writeRawConfig(raw);
    this.reload(true);
    return this.getHost(alias);
  }

  removeHost(alias) {
    validateAlias(alias);
    this.reload(true);
    const raw = this.readRawConfig();
    raw.hosts ??= {};
    raw.imports ??= {};

    if (!raw.hosts[alias]) {
      throw new Error(`SSH host alias "${alias}" does not exist.`);
    }
    delete raw.hosts[alias];
    this.writeRawConfig(raw);
    this.reload(true);
    return { alias };
  }

  setDisplayName(alias, displayName) {
    validateAlias(alias);
    const normalizedName = normalizeDisplayName(
      displayName,
      "displayName"
    );
    this.reload(true);
    const raw = this.readRawConfig();
    raw.hosts ??= {};
    raw.imports ??= {};

    if (!raw.hosts[alias]) {
      throw new Error(`SSH host alias "${alias}" does not exist.`);
    }
    raw.hosts[alias].displayName = normalizedName;
    this.writeRawConfig(raw);
    this.reload(true);
    return this.getHost(alias);
  }

  setPassword(alias, password) {
    validateAlias(alias);
    if (typeof password !== "string" || !password.trim()) {
      throw new Error("Password must be a non-empty string.");
    }
    this.reload(true);
    const raw = this.readRawConfig();
    raw.hosts ??= {};
    raw.imports ??= {};

    if (!raw.hosts[alias]) {
      throw new Error(`SSH host alias "${alias}" does not exist.`);
    }
    raw.hosts[alias].auth = {
      type: "password",
      password,
    };
    this.writeRawConfig(raw);
    this.reload(true);
    return this.getHost(alias);
  }

  getConfigPath() {
    return this.configPath;
  }

  getOpenSshConfigPath() {
    return this.openSshConfigPath;
  }

  getImportState() {
    this.reload();
    return this.raw.imports?.sshConfig ?? null;
  }

  get versionValue() {
    this.reload();
    return this.version;
  }

  getHost(alias) {
    this.reload();

    if (!alias || typeof alias !== "string") {
      throw new Error("A configured host alias is required.");
    }

    const host = this.hosts[alias];
    if (!host) {
      const configured = Object.keys(this.hosts).sort();
      const suffix =
        configured.length > 0
          ? ` Available aliases: ${configured.join(", ")}.`
          : " No hosts are configured yet.";
      throw new Error(
        `Unknown SSH host alias "${alias}".${suffix} Config file: ${this.configPath}`
      );
    }

    return { ...host, version: this.version };
  }

  listHosts() {
    this.reload();
    return Object.values(this.hosts)
      .sort((left, right) => left.alias.localeCompare(right.alias))
      .map((host) => ({
        alias: host.alias,
        displayName: host.displayName ?? host.alias,
        host: host.host,
        port: host.port,
        username: host.username,
        authType: host.auth.type,
        credentialSource:
          host.auth.type === "password"
            ? host.auth.password
              ? "inlinePassword"
              : "passwordEnv"
            : host.auth.type === "privateKey"
              ? host.auth.privateKey
                ? "inlinePrivateKey"
                : "privateKeyFile"
              : "agent",
        source: host.source,
        sshConfigAlias: host.sshConfigAlias,
        hostKeyPolicy: host.hostKeyPolicy,
        defaultCwd: host.defaultCwd,
        allowExec: host.allowExec,
        allowWrite: host.allowWrite,
        importWarnings: host.importWarnings,
      }));
  }
}
