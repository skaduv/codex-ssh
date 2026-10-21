import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  removePluginActivationFromToml,
  inferPluginIdFromRoot,
  resolveCacheFamilyRoot,
  resolveInstalledCacheRoot,
  stopWindowsPluginProcesses,
  validatePluginId,
} from "../scripts/uninstall-lib.mjs";

test("removes only Codex SSH activation tables from project config", () => {
  const source = [
    "[mcp_servers.other]",
    'command = "other"',
    "",
    '[plugins."codex-ssh@codex-ssh"]',
    "enabled = true",
    "",
    '[plugins."codex-ssh@codex-ssh".mcp_servers.ssh]',
    "enabled = true",
    'default_tools_approval_mode = "prompt"',
    "",
    "[features]",
    "example = true",
    "",
  ].join("\n");
  const updated = removePluginActivationFromToml(
    source,
    "codex-ssh@codex-ssh"
  );

  assert.match(updated, /\[mcp_servers\.other\]/);
  assert.match(updated, /\[features\]/);
  assert.equal(updated.includes("codex-ssh@codex-ssh"), false);
});

test("resolves a versioned plugin root to the whole cache family", () => {
  const versionedRoot = path.resolve(
    "/tmp/cache/codex-ssh/codex-ssh/0.5.0"
  );
  assert.equal(
    resolveCacheFamilyRoot(versionedRoot),
    path.dirname(versionedRoot)
  );
  assert.equal(
    resolveCacheFamilyRoot("/tmp/source/codex-ssh"),
    path.resolve("/tmp/source/codex-ssh")
  );
});

test("resolves the installed cache independently of the invoking source path", () => {
  assert.equal(
    resolveInstalledCacheRoot("codex-ssh@skaduv"),
    path.join(
      os.homedir(),
      ".codex",
      "plugins",
      "cache",
      "skaduv",
      "codex-ssh"
    )
  );
});

test("infers the marketplace name from an installed version directory", () => {
  assert.equal(
    inferPluginIdFromRoot("/tmp/.codex/plugins/cache/skaduv/codex-ssh/0.5.0"),
    "codex-ssh@skaduv"
  );
  assert.equal(inferPluginIdFromRoot("/tmp/source/codex-ssh"), undefined);
});

test("rejects unsafe plugin identifiers", () => {
  assert.equal(validatePluginId("codex-ssh@skaduv"), "codex-ssh@skaduv");
  assert.throws(
    () => validatePluginId("codex-ssh; Remove-Item C:\\"),
    /Invalid Codex plugin identifier/
  );
});

test(
  "stops a self-contained bundle process by its cache-path command line",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "codex-ssh-process-test-")
    );
    const cacheRoot = path.join(
      temporaryDirectory,
      "codex-ssh",
      "codex-ssh",
      "0.6.1"
    );
    fs.mkdirSync(cacheRoot, { recursive: true });
    const logPath = path.join(temporaryDirectory, "uninstall.log");
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", cacheRoot],
      {
        stdio: "ignore",
        windowsHide: true,
      }
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      stopWindowsPluginProcesses(cacheRoot, logPath);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.throws(() => process.kill(child.pid, 0));
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
);
