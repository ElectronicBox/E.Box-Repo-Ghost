import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
  exports?: Record<string, Record<string, string> | string>;
};

// Regression guard: the VS Code extension bundle is CommonJS and loads this
// package via require(). If the exports map ever loses its "require"
// condition, Node throws ERR_PACKAGE_PATH_NOT_EXPORTED and the extension
// fails to activate in every VS Code environment (unit tests run as ESM and
// will not catch that).
describe("@repo-ghost/core package exports", () => {
  const entry = manifest.exports?.["."];

  it("exposes a '.' entry in the exports map", () => {
    expect(entry).toBeTruthy();
  });

  it("declares both import and require conditions for CJS + ESM consumers", () => {
    if (typeof entry === "string") return; // a bare string export works for both
    expect(entry.import).toBeTypeOf("string");
    expect(entry.require).toBeTypeOf("string");
  });

  it("declares a types condition", () => {
    if (typeof entry === "string") return;
    expect(entry.types).toBeTypeOf("string");
  });
});
