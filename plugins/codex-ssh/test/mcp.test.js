import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginDirectory = path.resolve(testDirectory, "..");

test("starts the MCP server and exposes the SSH tool catalog", async (context) => {
  context.timeout = 20_000;
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-ssh-mcp-")
  );
  const configPath = path.join(temporaryDirectory, "servers.json");
  fs.writeFileSync(configPath, JSON.stringify({ hosts: {} }), "utf8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginDirectory, "server/index.js")],
    cwd: pluginDirectory,
    env: {
      ...process.env,
      CODEX_SSH_CONFIG: configPath,
      CODEX_SSH_AUTO_IMPORT: "false",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "codex-ssh-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "ssh_add_host",
      "ssh_download_file",
      "ssh_exec",
      "ssh_import_ssh_config",
      "ssh_list_directory",
      "ssh_list_hosts",
      "ssh_read_file",
      "ssh_remove_host",
      "ssh_set_display_name",
      "ssh_set_host_password",
      "ssh_test_connection",
      "ssh_uninstall_plugin",
      "ssh_upload_file",
      "ssh_write_file",
    ]);

    const listResult = await client.callTool({
      name: "ssh_list_hosts",
      arguments: {},
    });
    assert.equal(listResult.isError, undefined);
    assert.equal(listResult.structuredContent.configExists, true);
    assert.deepEqual(listResult.structuredContent.hosts, []);

    const addResult = await client.callTool({
      name: "ssh_add_host",
      arguments: {
        alias: "local-test",
        useSshConfig: false,
        host: "127.0.0.9",
        username: "tester",
        authType: "password",
        password: "first-inline-password",
        displayName: "本地测试服务器",
      },
    });
    assert.equal(addResult.isError, undefined);
    assert.equal(addResult.structuredContent.host.alias, "local-test");
    assert.equal(
      addResult.structuredContent.host.credentialSource,
      "inlinePassword"
    );
    assert.equal(
      JSON.stringify(addResult.structuredContent).includes(
        "first-inline-password"
      ),
      false
    );
    assert.equal(
      addResult.structuredContent.host.displayName,
      "本地测试服务器"
    );

    const renameResult = await client.callTool({
      name: "ssh_set_display_name",
      arguments: {
        alias: "local-test",
        displayName: "本地测试环境",
      },
    });
    assert.equal(renameResult.isError, undefined);
    assert.equal(
      renameResult.structuredContent.host.displayName,
      "本地测试环境"
    );

    const passwordResult = await client.callTool({
      name: "ssh_set_host_password",
      arguments: {
        alias: "local-test",
        password: "replacement-inline-password",
      },
    });
    assert.equal(passwordResult.isError, undefined);
    assert.equal(passwordResult.structuredContent.credentialStored, true);
    assert.equal(
      JSON.stringify(passwordResult.structuredContent).includes(
        "replacement-inline-password"
      ),
      false
    );
    const hostsAfterPassword = await client.callTool({
      name: "ssh_list_hosts",
      arguments: {},
    });
    assert.equal(
      JSON.stringify(hostsAfterPassword.structuredContent).includes(
        "replacement-inline-password"
      ),
      false
    );

    const uninstallGuardResult = await client.callTool({
      name: "ssh_uninstall_plugin",
      arguments: {
        confirm: false,
      },
    });
    assert.equal(uninstallGuardResult.isError, true);
    assert.match(
      uninstallGuardResult.structuredContent.error,
      /confirm=true is required/
    );

    const removeResult = await client.callTool({
      name: "ssh_remove_host",
      arguments: {
        alias: "local-test",
      },
    });
    assert.equal(removeResult.isError, undefined);
    assert.equal(removeResult.structuredContent.alias, "local-test");

    const unknownHostResult = await client.callTool({
      name: "ssh_exec",
      arguments: {
        host: "missing",
        command: "pwd",
      },
    });
    assert.equal(unknownHostResult.isError, true);
    assert.match(
      unknownHostResult.structuredContent.error,
      /Unknown SSH host alias/
    );
  } finally {
    await client.close();
  }
});

test("the self-contained bundled MCP server starts without node_modules", async (context) => {
  context.timeout = 20_000;
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-ssh-bundle-")
  );
  const configPath = path.join(temporaryDirectory, "servers.json");
  fs.writeFileSync(configPath, JSON.stringify({ hosts: {} }), "utf8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginDirectory, "server/dist/index.cjs")],
    cwd: pluginDirectory,
    env: {
      ...process.env,
      CODEX_SSH_CONFIG: configPath,
      CODEX_SSH_AUTO_IMPORT: "false",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "codex-ssh-bundle-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(
      tools.tools.some((tool) => tool.name === "ssh_uninstall_plugin"),
      true
    );
    const listResult = await client.callTool({
      name: "ssh_list_hosts",
      arguments: {},
    });
    assert.equal(listResult.isError, undefined);
    assert.deepEqual(listResult.structuredContent.hosts, []);
  } finally {
    await client.close();
  }
});
