#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigPath } from "../server/config.js";

const configPath = defaultConfigPath();
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.resolve(scriptDirectory, "../config/servers.example.json");

if (fs.existsSync(configPath)) {
  console.log(`SSH config already exists: ${configPath}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.copyFileSync(examplePath, configPath, fs.constants.COPYFILE_EXCL);

if (process.platform !== "win32") {
  fs.chmodSync(configPath, 0o600);
}

console.log(`Created SSH config: ${configPath}`);
console.log("Replace the example host, username, and authentication settings before use.");
