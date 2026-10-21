#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_PLUGIN_ID = "codex-ssh@skaduv";
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/iu;
const defaultLogPath = path.join(os.tmpdir(), "codex-ssh-uninstall.log");

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function validatePluginId(pluginId) {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(`Invalid Codex plugin identifier: ${pluginId}`);
  }
  return pluginId;
}

export function resolveCacheFamilyRoot(pluginRoot) {
  const normalizedRoot = path.resolve(pluginRoot);
  const parent = path.dirname(normalizedRoot);
  const versionName = path.basename(normalizedRoot);
  if (
    /^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(versionName) &&
    path.basename(parent).toLowerCase() === "codex-ssh"
  ) {
    return parent;
  }
  return normalizedRoot;
}

export function resolveInstalledCacheRoot(pluginId) {
  validatePluginId(pluginId);
  const [pluginName, marketplaceName] = pluginId.split("@");
  return path.join(
    os.homedir(),
    ".codex",
    "plugins",
    "cache",
    marketplaceName,
    pluginName
  );
}

export function inferPluginIdFromRoot(pluginRoot) {
  const normalizedRoot = path.resolve(pluginRoot);
  const versionName = path.basename(normalizedRoot);
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(versionName)) {
    return undefined;
  }

  const pluginFamily = path.dirname(normalizedRoot);
  const marketplaceDirectory = path.dirname(pluginFamily);
  if (
    path.basename(path.dirname(marketplaceDirectory)).toLowerCase() !== "cache"
  ) {
    return undefined;
  }

  const pluginName = path.basename(pluginFamily);
  const marketplaceName = path.basename(marketplaceDirectory);
  if (
    !pluginName ||
    !marketplaceName ||
    pluginName === "cache" ||
    marketplaceName === "plugins"
  ) {
    return undefined;
  }
  return `${pluginName}@${marketplaceName}`;
}

export function removePluginActivationFromToml(source, pluginId) {
  validatePluginId(pluginId);
  const prefix = `[plugins."${pluginId}"`;
  const output = [];
  let skippingPluginTable = false;

  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      skippingPluginTable =
        trimmed.startsWith(`${prefix}]`) || trimmed.startsWith(`${prefix}.`);
    }
    if (!skippingPluginTable) {
      output.push(line);
    }
  }

  const result = output.join("\n").trimEnd();
  return result ? `${result}\n` : "";
}

function writeLog(logPath, message) {
  fs.appendFileSync(
    logPath,
    `[${new Date().toISOString()}] ${message}\n`,
    "utf8"
  );
}

function processExists(processId) {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function stopWindowsPluginProcesses(cacheRoot, logPath) {
  if (process.platform !== "win32") {
    return;
  }

  const escapedRoot = cacheRoot.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$root = '${escapedRoot}'`,
    "Get-Process -Name node -ErrorAction SilentlyContinue | ForEach-Object {",
    "  $candidate = $_",
    "  try {",
    "    $matches = @($candidate.Modules | Where-Object {",
    "      $_.FileName.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)",
    "    })",
    "    if ($matches.Count -gt 0) {",
    "      Stop-Process -Id $candidate.Id -Force -ErrorAction SilentlyContinue",
    "    }",
    "  } catch {}",
    "}",
  ].join("\n");

  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(script),
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    }
  );

  if (result.error) {
    writeLog(logPath, `Process cleanup warning: ${result.error.message}`);
  } else if (result.status !== 0) {
    writeLog(
      logPath,
      `Process cleanup exited with code ${result.status}: ${result.stderr.trim()}`
    );
  }
}

function removeViaCodex(pluginId, logPath) {
  validatePluginId(pluginId);
  let result;
  if (process.platform === "win32") {
    result = spawnSync(
      process.env.ComSpec || "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        `codex plugin remove ${pluginId} --json`,
      ],
      {
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
      }
    );
  } else {
    result = spawnSync(
      "codex",
      ["plugin", "remove", pluginId, "--json"],
      {
        encoding: "utf8",
        timeout: 120_000,
      }
    );
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0) {
    writeLog(
      logPath,
      `Codex removal failed${result.error ? `: ${result.error.message}` : ""}${output ? `: ${output}` : ""}`
    );
    return false;
  }

  writeLog(logPath, `Codex removal succeeded: ${output || "no output"}`);
  return true;
}

function cleanProjectActivation(projectRoot, pluginId, logPath) {
  if (!projectRoot) {
    return;
  }
  const configPath = path.join(path.resolve(projectRoot), ".codex", "config.toml");
  if (!fs.existsSync(configPath)) {
    return;
  }

  try {
    const source = fs.readFileSync(configPath, "utf8");
    const updated = removePluginActivationFromToml(source, pluginId);
    if (updated === source) {
      return;
    }
    if (!updated.trim()) {
      fs.unlinkSync(configPath);
      writeLog(logPath, `Removed project activation config: ${configPath}`);
      return;
    }
    fs.writeFileSync(configPath, updated, "utf8");
    writeLog(logPath, `Removed plugin activation from: ${configPath}`);
  } catch (error) {
    writeLog(
      logPath,
      `Project activation cleanup warning for ${configPath}: ${error.message}`
    );
  }
}

function removeHostConfigIfRequested(deleteHostConfig, logPath) {
  if (!deleteHostConfig) {
    return;
  }
  const hostConfigPath = path.join(os.homedir(), ".codex-ssh", "servers.json");
  try {
    fs.rmSync(path.dirname(hostConfigPath), { recursive: true, force: true });
    writeLog(logPath, `Deleted host config: ${path.dirname(hostConfigPath)}`);
  } catch (error) {
    writeLog(
      logPath,
      `Host config cleanup warning for ${hostConfigPath}: ${error.message}`
    );
  }
}

export async function runUninstallHelper(options) {
  const {
    cacheRoot,
    pluginId,
    projectRoot,
    deleteHostConfig,
    waitPid,
    logPath,
    initialDelayMs,
  } = options;
  fs.writeFileSync(logPath, "", "utf8");
  writeLog(logPath, `Starting detached uninstall for ${pluginId}`);
  writeLog(logPath, `Plugin cache root: ${cacheRoot}`);

  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
  }

  const waitUntil = Date.now() + 5_000;
  while (processExists(waitPid) && Date.now() < waitUntil) {
    await sleep(250);
  }

  let removed = false;
  for (let attempt = 1; attempt <= 3 && !removed; attempt += 1) {
    stopWindowsPluginProcesses(cacheRoot, logPath);
    await sleep(700);
    removed = removeViaCodex(pluginId, logPath);
    if (!removed) {
      await sleep(1_000);
    }
  }

  if (removed) {
    cleanProjectActivation(projectRoot, pluginId, logPath);
    removeHostConfigIfRequested(deleteHostConfig, logPath);
    writeLog(logPath, "Uninstall completed.");
  } else {
    writeLog(
      logPath,
      "Uninstall failed after retries. Close Codex completely and rerun the uninstall command."
    );
  }
  process.exitCode = removed ? 0 : 1;
}

export function scheduleUninstall({
  pluginRoot = process.env.PLUGIN_ROOT || process.cwd(),
  pluginId,
  projectRoot,
  deleteHostConfig = false,
  waitPid = process.pid,
  initialDelayMs = 1_500,
  logPath = defaultLogPath,
} = {}) {
  const resolvedPluginRoot = fs.realpathSync(path.resolve(pluginRoot));
  const effectivePluginId =
    pluginId ??
    inferPluginIdFromRoot(resolvedPluginRoot) ??
    DEFAULT_PLUGIN_ID;
  validatePluginId(effectivePluginId);
  const installedCacheRoot = resolveInstalledCacheRoot(effectivePluginId);
  const cacheRoot = fs.existsSync(installedCacheRoot)
    ? installedCacheRoot
    : resolveCacheFamilyRoot(resolvedPluginRoot);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-ssh-uninstall-")
  );
  const helperPath = path.join(temporaryDirectory, "uninstall.mjs");
  const helperSourcePath = path.join(
    resolvedPluginRoot,
    "scripts",
    "uninstall.mjs"
  );
  fs.copyFileSync(helperSourcePath, helperPath);

  const args = [
    helperPath,
    "--helper",
    "--cache-root",
    cacheRoot,
    "--plugin-id",
    effectivePluginId,
    "--wait-pid",
    String(waitPid),
    "--delay-ms",
    String(initialDelayMs),
    "--log-path",
    logPath,
  ];
  if (projectRoot) {
    args.push("--project-root", path.resolve(projectRoot));
  }
  if (deleteHostConfig) {
    args.push("--delete-host-config");
  }

  const helper = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  helper.unref();

  return {
    status: "scheduled",
    pluginId: effectivePluginId,
    cacheRoot,
    helperPath,
    logPath,
    message:
      "The detached uninstaller will stop Codex SSH MCP processes, remove the installed plugin cache, and keep host config by default.",
  };
}
