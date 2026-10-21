import os from "node:os";
import path from "node:path";

export function expandHome(value) {
  if (typeof value !== "string" || !value.trim()) {
    return value;
  }

  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}
