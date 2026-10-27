import { describe, expect, it, vi } from "vitest";
import { openRiskMapView, renderRiskMapHtml } from "./riskMapView.js";
import type { RiskEntry } from "@repo-ghost/core";

const { panel, getRiskMap } = vi.hoisted(() => ({
  panel: {
    webview: { html: "", cspSource: "vscode-resource:" },
    dispose: vi.fn(),
  },
  getRiskMap: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: { createWebviewPanel: vi.fn(() => panel) },
  ViewColumn: { One: 1 },
}));
vi.mock("@repo-ghost/core", () => ({ getRiskMap }));

const assets = {
  html: "<title><!-- REPO_GHOST_TITLE --></title><!-- REPO_GHOST_CSP --><!-- REPO_GHOST_CSS --><!-- REPO_GHOST_DATA --><!-- REPO_GHOST_JS -->",
  css: "table { color: red; }",
  js: "window.renderRiskMap();",
};

const entries: RiskEntry[] = [
  {
    filePath: "src/a.ts",
    commitCount: 12,
    distinctAuthors: 3,
    revertCount: 1,
    churn: 40,
    riskScore: 82.5,
  },
];

describe("renderRiskMapHtml", () => {
  it("embeds escaped data and all static webview assets", () => {
    const html = renderRiskMapHtml(entries, assets, "test-nonce");

    expect(html).toContain("Risk map (1 files)");
    expect(html).toContain("<style nonce=\"test-nonce\">table { color: red; }</style>");
    expect(html).toContain('nonce="test-nonce"');
    expect(html).toContain("<script nonce=\"test-nonce\">window.__REPO_GHOST_DATA__=");
    expect(html).toContain("\"src/a.ts\"");
    expect(html).toContain("<script nonce=\"test-nonce\">window.renderRiskMap();</script>");
  });

  it("adds a CSP nonce to every inline style and script", () => {
    const html = renderRiskMapHtml(entries, assets, "nonce-123");

    expect(html).toContain('<style nonce="nonce-123">');
    expect(html).toContain('<script nonce="nonce-123">window.__REPO_GHOST_DATA__=');
    expect(html).toContain('<script nonce="nonce-123">window.renderRiskMap();</script>');
  });

  it("renders a large entry set without duplicating markup per sort state", () => {
    const largeEntries = Array.from({ length: 501 }, (_, index) => ({
      ...entries[0],
      filePath: `src/file-${index}.ts`,
      riskScore: index % 101,
    }));
    const html = renderRiskMapHtml(largeEntries, assets);

    expect(html).toContain("Risk map (501 files)");
    expect(html.match(/window.__REPO_GHOST_DATA__/g)).toHaveLength(1);
    expect(html).toContain("src/file-500.ts");
  });

  it("escapes HTML title content and prevents closing-script injection", () => {
    const html = renderRiskMapHtml(
      [{ ...entries[0], filePath: "</script><script>alert(1)</script>" }],
      assets,
    );

    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c/script>");
  });

  it("shows a visible error when risk-map loading rejects", async () => {
    getRiskMap.mockRejectedValue(new Error("git unavailable"));
    const output = {
      channel: {},
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      dispose: vi.fn(),
    };

    await openRiskMapView(
      { extensionPath: "C:\\extension" } as never,
      "C:\\repo",
      output as never,
    );

    expect(output.error).toHaveBeenCalledWith("git unavailable");
    expect(panel.webview.html).toContain("git unavailable");
  });
});
