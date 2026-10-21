import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function fingerprintKey(key) {
  const digest = crypto.createHash("sha256").update(key).digest("base64");
  return `SHA256:${digest.replace(/=+$/u, "")}`;
}

function readStore(storePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Known-host store must contain a JSON object.");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: 1, hosts: {} };
    }
    throw new Error(`Cannot read known-host store ${storePath}: ${error.message}`);
  }
}

function writeStore(storePath, store) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, storePath);
}

export class HostKeyStore {
  constructor(hostConfig) {
    this.hostConfig = hostConfig;
    this.identity = `${hostConfig.host.toLowerCase()}:${hostConfig.port}`;
  }

  verify(rawKey) {
    const actual = fingerprintKey(rawKey);
    const policy = this.hostConfig.hostKeyPolicy;

    if (policy === "insecure") {
      return true;
    }

    if (policy === "pinned") {
      const expected = this.hostConfig.hostFingerprint;
      if (actual !== expected) {
        throw new Error(
          `SSH host key mismatch for ${this.identity}. Expected ${expected}, received ${actual}.`
        );
      }
      return true;
    }

    const storePath = this.hostConfig.knownHostsPath;
    const store = readStore(storePath);
    const previous = store.hosts?.[this.identity];

    if (previous) {
      if (previous.fingerprint !== actual) {
        throw new Error(
          `SSH host key mismatch for ${this.identity}. Stored ${previous.fingerprint}, received ${actual}. Remove or correct the entry in ${storePath} only after verifying the server identity.`
        );
      }
      return true;
    }

    store.hosts ??= {};
    store.hosts[this.identity] = {
      fingerprint: actual,
      trustedAt: new Date().toISOString(),
    };
    writeStore(storePath, store);
    return true;
  }
}
