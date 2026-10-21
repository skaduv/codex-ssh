#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveCacheFamilyRoot,
  runUninstallHelper,
  scheduleUninstall,
} from "./uninstall-lib.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const pluginRoot = path.resolve(scriptDirectory, "..");

function parseArguments(argv) {
  const options = {
    pluginRoot,
    cacheRoot: undefined,
    pluginId: undefined,
    projectRoot: undefined,
    deleteHostConfig: false,
    waitPid: 0,
    initialDelayMs: 0,
    logPath: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--helper") {
      options.helper = true;
    } else if (argument === "--delete-host-config") {
      options.deleteHostConfig = true;
    } else {
      const key = argument.replace(/^--/u, "").replace(
        /-([a-z])/gu,
        (_, character) => character.toUpperCase()
      );
      if (key in options) {
        options[key] = argv[index + 1];
        index += 1;
      }
    }
  }

  if (options.cacheRoot) {
    options.cacheRoot = path.resolve(options.cacheRoot);
  }
  if (options.pluginRoot) {
    options.pluginRoot = path.resolve(options.pluginRoot);
  }
  if (options.projectRoot) {
    options.projectRoot = path.resolve(options.projectRoot);
  }
  options.waitPid = Number.parseInt(String(options.waitPid), 10) || 0;
  options.initialDelayMs =
    Number.parseInt(String(options.initialDelayMs), 10) || 0;
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.helper) {
  await runUninstallHelper({
    ...options,
    cacheRoot:
      options.cacheRoot ?? resolveCacheFamilyRoot(options.pluginRoot),
  });
} else {
  const result = scheduleUninstall({
    pluginRoot: options.pluginRoot,
    pluginId: options.pluginId,
    projectRoot: options.projectRoot,
    deleteHostConfig: options.deleteHostConfig,
    waitPid: options.waitPid || process.pid,
    initialDelayMs: options.initialDelayMs,
    logPath: options.logPath,
  });
  console.log(JSON.stringify(result, null, 2));
}
