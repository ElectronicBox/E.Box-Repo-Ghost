import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("risk map webview event handling", () => {
  it("guards non-element event targets before calling closest", async () => {
    const source = await readFile(
      join(process.cwd(), "src", "webview", "riskMapView.js"),
      "utf8",
    );
    expect(source).toContain("if (!(event.target instanceof Element)) return;");
  });
});
