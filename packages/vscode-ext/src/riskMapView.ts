import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { getRiskMap, type RiskEntry } from "@repo-ghost/core";
import type { RepoGhostOutput } from "./outputChannel.js";

export interface RiskMapAssets {
  html: string;
  css: string;
  js: string;
}

const WEBVIEW_DIRECTORY = ["dist", "webview"];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderRiskMapHtml(
  entries: RiskEntry[],
  assets: RiskMapAssets,
  nonce = "",
): string {
  const data = JSON.stringify(entries).replaceAll("<", "\\u003c");
  const safeNonce = nonce || randomBytes(16).toString("hex");
  return assets.html
    .replace(
      /<!-- REPO_GHOST_CSP(?: nonce="[^"]*")? -->/,
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${escapeHtml(
        safeNonce,
      )}'; script-src 'nonce-${escapeHtml(safeNonce)}';">`,
    )
    .replace(
      "<!-- REPO_GHOST_CSS -->",
      `<style nonce="${escapeHtml(safeNonce)}">${assets.css}</style>`,
    )
    .replace(
      "<!-- REPO_GHOST_DATA -->",
      `<script nonce="${escapeHtml(safeNonce)}">window.__REPO_GHOST_DATA__=${data};</script>`,
    )
    .replace(
      "<!-- REPO_GHOST_JS -->",
      `<script nonce="${escapeHtml(safeNonce)}">${assets.js}</script>`,
    )
    .replace("<!-- REPO_GHOST_TITLE -->", escapeHtml(`Risk map (${entries.length} files)`));
}

export async function loadRiskMapAssets(extensionPath: string): Promise<RiskMapAssets> {
  const directory = join(extensionPath, ...WEBVIEW_DIRECTORY);
  const [html, css, js] = await Promise.all([
    readFile(join(directory, "riskMapView.html"), "utf8"),
    readFile(join(directory, "riskMapView.css"), "utf8"),
    readFile(join(directory, "riskMapView.js"), "utf8"),
  ]);
  return { html, css, js };
}

export async function openRiskMapView(
  context: vscode.ExtensionContext,
  directory: string,
  output: RepoGhostOutput,
): Promise<vscode.WebviewPanel> {
  const panel = vscode.window.createWebviewPanel(
    "repoGhostRiskMap",
    "Repo Ghost Risk Map",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  try {
    const [entries, assets] = await Promise.all([
      getRiskMap(directory),
      loadRiskMapAssets(context.extensionPath),
    ]);
    panel.webview.html = renderRiskMapHtml(entries, assets, randomBytes(16).toString("hex"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load risk map.";
    output.error(message);
    panel.webview.html = `<html><body><h1>Repo Ghost Risk Map</h1><p>${escapeHtml(message)}</p></body></html>`;
  }
  return panel;
}
