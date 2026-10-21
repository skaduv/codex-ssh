import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginDirectory = path.resolve(testDirectory, "..");
const repositoryRoot = path.resolve(pluginDirectory, "../..");

test("plugin and marketplace manifests point at the MCP server", () => {
  const plugin = JSON.parse(
    fs.readFileSync(path.join(pluginDirectory, "plugin.json"), "utf8")
  );
  const mcp = JSON.parse(
    fs.readFileSync(path.join(pluginDirectory, "mcp.json"), "utf8")
  );
  const marketplace = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, ".agents/plugins/marketplace.json"),
      "utf8"
    )
  );

  assert.equal(plugin.name, "codex-ssh");
  assert.equal(mcp.mcpServers.ssh.type, "stdio");
  const serverArgument = mcp.mcpServers.ssh.args[0].replace(
    "${PLUGIN_ROOT}",
    pluginDirectory
  );
  assert.equal(
    fs.existsSync(serverArgument),
    true
  );
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.equal(
    fs.existsSync(
      path.resolve(repositoryRoot, marketplace.plugins[0].source.path)
    ),
    true
  );
});
