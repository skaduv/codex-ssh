import { build } from "esbuild";

await build({
  entryPoints: ["server/index.js"],
  outfile: "server/dist/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["cpu-features", "*.node"],
  legalComments: "none",
  logLevel: "info",
});
