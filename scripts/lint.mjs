import { readFile } from "node:fs/promises";

const manifests = ["package.json", "packages/core/package.json", "packages/vscode-ext/package.json", "packages/claude-skill/package.json"];
for (const path of manifests) {
  JSON.parse(await readFile(path, "utf8"));
}
console.log(`Validated ${manifests.length} JSON manifests.`);
