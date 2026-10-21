import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ssh2 from "ssh2";
import { ConfigStore } from "../server/config.js";
import { SshManager } from "../server/ssh-manager.js";

const { Server } = ssh2;

test("uses an inline password without exposing it in command output", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: "pkcs1",
      format: "pem",
    },
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
  });
  const password = "local-config-password";

  const sshServer = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (context) => {
      if (
        context.method === "password" &&
        context.username === "tester" &&
        context.password === password
      ) {
        context.accept();
      } else {
        context.reject();
      }
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept) => {
          const stream = accept();
          stream.write("inline-password-ok\n");
          stream.exit(0);
          stream.end();
        });
      });
    });
  });

  await new Promise((resolve) => sshServer.listen(0, "127.0.0.1", resolve));
  const address = sshServer.address();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ssh-auth-"));
  const configPath = path.join(directory, "servers.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        hosts: {
          local: {
            host: "127.0.0.1",
            port: address.port,
            username: "tester",
            auth: {
              type: "password",
              password,
            },
            hostKeyPolicy: "insecure",
          },
        },
      },
      null,
      2
    )
  );
  const store = new ConfigStore({
    env: {
      CODEX_SSH_CONFIG: configPath,
      CODEX_SSH_AUTO_IMPORT: "false",
    },
  });
  const manager = new SshManager(store);

  try {
    const result = await manager.exec("local", "true");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /inline-password-ok/);
    assert.equal(JSON.stringify(result).includes(password), false);
    assert.equal(JSON.stringify(store.listHosts()).includes(password), false);
  } finally {
    manager.closeAll();
    await new Promise((resolve) => sshServer.close(resolve));
  }
});
