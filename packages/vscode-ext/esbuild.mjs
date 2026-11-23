import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/extension.js",
  sourcemap: true,
  // Bundle @repo-ghost/core into the extension so the extension host never
  // resolves the workspace package at runtime. This keeps the extension
  // working on every VS Code/Node combination (including hosts without
  // require(ESM) support) instead of depending on core's exports map.
  // Only the vscode API and zod (a properly dual-published dependency)
  // stay external.
  external: ["vscode", "zod"],
});

await mkdir("dist/webview", { recursive: true });
await cp("src/webview", "dist/webview", { recursive: true });
