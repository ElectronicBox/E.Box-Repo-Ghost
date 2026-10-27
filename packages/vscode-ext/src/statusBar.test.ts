import { describe, expect, it, vi } from "vitest";
import { createStatusBar } from "./statusBar.js";

const item = {
  show: vi.fn(),
  dispose: vi.fn(),
  text: "",
  tooltip: "",
  command: "",
};

vi.mock("vscode", () => ({
  StatusBarAlignment: { Left: 1 },
  window: {
    createStatusBarItem: vi.fn(() => item),
  },
}));

describe("createStatusBar", () => {
  it("updates enabled state and disposes the item", () => {
    const subscriptions: unknown[] = [];
    const controller = createStatusBar({ subscriptions } as never);

    expect(item.show).toHaveBeenCalledOnce();
    expect(item.command).toBe("repo-ghost.enableProvider");
    controller.setEnabled(true);
    expect(item.text).toBe("$(check) Repo Ghost");
    controller.dispose();
    expect(item.dispose).toHaveBeenCalledOnce();
    expect(subscriptions).toContain(item);
  });
});
