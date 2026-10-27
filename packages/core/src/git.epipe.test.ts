import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
const { simpleGit } = vi.hoisted(() => ({ simpleGit: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn }));
vi.mock("simple-git", () => ({ simpleGit }));

import { getFileHistory } from "./git.js";

describe("git stdout edge cases", () => {
  it("ignores EPIPE stdout errors while streaming history", async () => {
    const stdout = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(
          "\x1ea1b2c3d4e5f6789012345678901234567890abcd\0Test User\0test@example.test\0",
        );
        yield Buffer.from("2025-01-01T00:00:00Z\0Add file\n");
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    simpleGit.mockReturnValue({
      revparse: vi.fn().mockResolvedValue(process.cwd()),
    });
    spawn.mockImplementation(() => {
      setImmediate(() => {
        stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
        child.emit("close", 0);
      });
      return child;
    });
    const history: unknown[] = [];
    const pending = (async () => {
      for await (const commit of getFileHistory(join(process.cwd(), "package.json"))) {
        history.push(commit);
      }
    })();
    await expect(pending).resolves.toBeUndefined();
    expect(history).toHaveLength(1);
  });
});
