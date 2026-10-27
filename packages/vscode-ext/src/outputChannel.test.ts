import { describe, expect, it, vi } from "vitest";
import { createOutputChannel } from "./outputChannel.js";

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(),
  },
}));

describe("createOutputChannel", () => {
  it("writes levelled messages and disposes the underlying channel", () => {
    const channel = {
      appendLine: vi.fn(),
      dispose: vi.fn(),
    };
    const output = createOutputChannel(channel as never);

    output.info("started");
    output.warn("slow");
    output.error("failed");
    output.dispose();

    expect(channel.appendLine).toHaveBeenNthCalledWith(1, "[info] started");
    expect(channel.appendLine).toHaveBeenNthCalledWith(2, "[warn] slow");
    expect(channel.appendLine).toHaveBeenNthCalledWith(3, "[error] failed");
    expect(channel.dispose).toHaveBeenCalledOnce();
  });
});
