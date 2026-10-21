import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../server/config.js";
import { fingerprintKey, HostKeyStore } from "../server/host-key-store.js";
import { discoverOpenSshAliases } from "../server/openssh-config.js";
import { SshManager } from "../server/ssh-manager.js";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-ssh-test-"));
}

function writeConfig(directory, config) {
  const configPath = path.join(directory, "servers.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function testEnv(configPath, extra = {}) {
  return {
    CODEX_SSH_CONFIG: configPath,
    CODEX_SSH_AUTO_IMPORT: "false",
    ...extra,
  };
}

test("loads aliases without exposing auth environment names", () => {
  const directory = temporaryDirectory();
  const configPath = writeConfig(directory, {
    hosts: {
      prod: {
        host: "127.0.0.1",
        username: "deploy",
        auth: {
          type: "password",
          passwordEnv: "PRIVATE_PASSWORD_VARIABLE",
        },
        commandPolicy: {
          allowedPatterns: ["^uptime$"],
          deniedPatterns: ["rm -rf"],
        },
      },
    },
  });

  const store = new ConfigStore({
    env: testEnv(configPath),
  });
  const hosts = store.listHosts();

  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].alias, "prod");
  assert.equal(hosts[0].authType, "password");
  assert.equal(JSON.stringify(hosts).includes("PRIVATE_PASSWORD_VARIABLE"), false);
});

test("keeps inline credentials internal and out of public host listings", () => {
  const directory = temporaryDirectory();
  const password = "inline-password-value";
  const passphrase = "inline-passphrase-value";
  const configPath = writeConfig(directory, {
    hosts: {
      passwordHost: {
        host: "password.example",
        username: "deploy",
        auth: {
          type: "password",
          password,
        },
      },
      keyHost: {
        host: "key.example",
        username: "deploy",
        auth: {
          type: "privateKey",
          privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
          passphrase,
        },
      },
    },
  });
  const store = new ConfigStore({
    env: testEnv(configPath),
  });

  const publicHosts = store.listHosts();
  assert.equal(
    publicHosts.find((host) => host.alias === "passwordHost").credentialSource,
    "inlinePassword"
  );
  assert.equal(
    publicHosts.find((host) => host.alias === "keyHost").credentialSource,
    "inlinePrivateKey"
  );
  const serialized = JSON.stringify(publicHosts);
  assert.equal(serialized.includes(password), false);
  assert.equal(serialized.includes(passphrase), false);
  assert.equal(store.getHost("passwordHost").auth.password, password);
  assert.equal(store.getHost("keyHost").auth.passphrase, passphrase);
});

test("reloads a changed host config", () => {
  const directory = temporaryDirectory();
  const configPath = writeConfig(directory, {
    hosts: {
      first: {
        host: "host-one.example",
        username: "user",
        auth: { type: "agent" },
      },
    },
  });
  const store = new ConfigStore({
    env: testEnv(configPath),
  });
  assert.deepEqual(store.listHosts().map((host) => host.alias), ["first"]);

  writeConfig(directory, {
    hosts: {
      second: {
        host: "host-two.example",
        username: "user",
        auth: { type: "agent" },
      },
    },
  });

  assert.deepEqual(store.listHosts().map((host) => host.alias), ["second"]);
});

test("requires a fingerprint for pinned host keys", () => {
  const directory = temporaryDirectory();
  const configPath = writeConfig(directory, {
    hosts: {
      bad: {
        host: "bad.example",
        username: "user",
        auth: { type: "agent" },
        hostKeyPolicy: "pinned",
      },
    },
  });

  assert.throws(
    () => new ConfigStore({ env: testEnv(configPath) }),
    /hostFingerprint is required/
  );
});

test("writes a TOFU fingerprint and rejects a changed key", () => {
  const directory = temporaryDirectory();
  const storePath = path.join(directory, "known_hosts.json");
  const config = {
    host: "example.com",
    port: 22,
    hostKeyPolicy: "tofu",
    knownHostsPath: storePath,
  };
  const key = Buffer.from("test-host-key");
  const hostKeyStore = new HostKeyStore(config);

  assert.equal(hostKeyStore.verify(key), true);
  assert.equal(fingerprintKey(key).startsWith("SHA256:"), true);
  assert.equal(hostKeyStore.verify(key), true);
  assert.throws(
    () => hostKeyStore.verify(Buffer.from("another-key")),
    /host key mismatch/
  );
});

test("does not reuse stale hosts after the config becomes invalid", () => {
  const directory = temporaryDirectory();
  const configPath = writeConfig(directory, {
    hosts: {
      prod: {
        host: "prod.example",
        username: "user",
        auth: { type: "agent" },
      },
    },
  });
  const store = new ConfigStore({
    env: testEnv(configPath),
  });
  assert.equal(store.listHosts().length, 1);

  fs.writeFileSync(configPath, "{ invalid json", "utf8");
  assert.throws(() => store.listHosts(), /Invalid SSH config/);
  assert.throws(() => store.listHosts(), /Invalid SSH config/);
});

test("enforces per-host command patterns before connecting", () => {
  const directory = temporaryDirectory();
  const configPath = writeConfig(directory, {
    hosts: {
      prod: {
        host: "prod.example",
        username: "user",
        auth: { type: "agent" },
        commandPolicy: {
          allowedPatterns: ["^uptime$"],
          deniedPatterns: ["rm -rf"],
        },
      },
    },
  });
  const store = new ConfigStore({
    env: testEnv(configPath),
  });
  const manager = new SshManager(store);
  const host = store.getHost("prod");

  assert.doesNotThrow(() => manager.assertCommandAllowed(host, "uptime"));
  assert.throws(
    () => manager.assertCommandAllowed(host, "df -h"),
    /does not match allowedPatterns/
  );
  assert.throws(
    () => manager.assertCommandAllowed(host, "uptime && rm -rf /srv/cache"),
    /deniedPatterns/
  );
});

test("discovers concrete OpenSSH hosts from included files", () => {
  const directory = temporaryDirectory();
  const sshDirectory = path.join(directory, "ssh");
  const includeDirectory = path.join(sshDirectory, "config.d");
  fs.mkdirSync(includeDirectory, { recursive: true });
  const configPath = path.join(sshDirectory, "config");
  fs.writeFileSync(
    configPath,
    [
      "Include config.d/*.conf",
      "Host direct",
      "  HostName direct.example",
      "  User deploy",
      "  Port 2202",
      "Host *.example",
      "  User wildcard",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(includeDirectory, "included.conf"),
    ["Host included", "  HostName included.example", ""].join("\n")
  );

  const result = discoverOpenSshAliases(configPath);
  assert.deepEqual(result.aliases, ["direct", "included"]);
  assert.equal(result.configExists, true);
});

test("imports OpenSSH hosts once and persists add/remove changes", () => {
  const directory = temporaryDirectory();
  const sshConfigPath = path.join(directory, "ssh_config");
  const configPath = path.join(directory, "servers.json");
  fs.writeFileSync(
    sshConfigPath,
    [
      "Host prod",
      "  HostName 127.0.0.1",
      "  User deploy",
      "  Port 2222",
      "  IdentityFile ~/.ssh/id_test",
      "Host *.internal",
      "  User wildcard",
      "",
    ].join("\n")
  );

  const env = {
    CODEX_SSH_CONFIG: configPath,
    CODEX_SSH_OPENSSH_CONFIG: sshConfigPath,
    CODEX_SSH_AUTO_IMPORT: "true",
  };
  const store = new ConfigStore({ env });
  assert.deepEqual(store.listHosts().map((host) => host.alias), ["prod"]);
  assert.equal(store.listHosts()[0].source, "sshConfig");
  assert.equal(store.getImportState().importedCount, 1);

  configStoreAddAndRemove(store);
  const secondStore = new ConfigStore({ env });
  assert.equal(
    secondStore.listHosts().some((host) => host.alias === "prod"),
    false
  );
  assert.equal(
    secondStore.listHosts().some((host) => host.alias === "manual"),
    true
  );
});

test("supports Unicode display names without changing the stable alias", () => {
  const directory = temporaryDirectory();
  const configPath = writeConfig(directory, {
    hosts: {
      prod: {
        host: "127.0.0.3",
        username: "deploy",
        auth: { type: "agent" },
        displayName: "生产服务器 A",
      },
    },
  });
  const store = new ConfigStore({
    env: testEnv(configPath),
  });

  assert.equal(store.getHost("prod").displayName, "生产服务器 A");
  assert.equal(store.listHosts()[0].displayName, "生产服务器 A");

  store.setDisplayName("prod", "生产环境 · 主站");
  assert.equal(store.getHost("prod").displayName, "生产环境 · 主站");
  assert.equal(store.getHost("prod").alias, "prod");
  assert.throws(
    () => store.setDisplayName("prod", "非法\u0000名称"),
    /control characters/
  );
});

test("retries automatic import when OpenSSH config appears later", () => {
  const directory = temporaryDirectory();
  const sshConfigPath = path.join(directory, "ssh_config");
  const configPath = path.join(directory, "servers.json");
  const env = {
    CODEX_SSH_CONFIG: configPath,
    CODEX_SSH_OPENSSH_CONFIG: sshConfigPath,
    CODEX_SSH_AUTO_IMPORT: "true",
  };

  const firstStore = new ConfigStore({ env });
  assert.deepEqual(firstStore.listHosts(), []);
  assert.equal(firstStore.getImportState().configExists, false);
  assert.equal(firstStore.getImportState().importedAt, undefined);

  fs.writeFileSync(
    sshConfigPath,
    ["Host later", "  HostName 127.0.0.2", "  User deploy", ""].join("\n")
  );

  const secondStore = new ConfigStore({ env });
  assert.deepEqual(secondStore.listHosts().map((host) => host.alias), ["later"]);
});

function configStoreAddAndRemove(store) {
  store.addHost("manual", {
    host: "manual.example",
    username: "operator",
    authType: "agent",
    defaultCwd: "/srv/app",
  });
  assert.equal(
    store.listHosts().some((host) => host.alias === "manual"),
    true
  );
  store.removeHost("prod");
}
