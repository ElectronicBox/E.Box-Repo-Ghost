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
  external: ["vscode"],
  packages: "external",
});

await mkdir("dist/webview", { recursive: true });
await cp("src/webview", "dist/webview", { recursive: true });
