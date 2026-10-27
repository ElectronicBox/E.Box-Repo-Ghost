import { EventEmitter } from "node:events";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
const { simpleGit } = vi.hoisted(() => ({ simpleGit: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn }));
vi.mock("simple-git", () => ({ simpleGit }));

import { getChurnStats } from "./git.js";

describe("getChurnStats malformed numstat", () => {
  it("warns and skips malformed additions and deletions", async () => {
    const stdout = new Readable({ read() {} });
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
        stdout.push("abc\tdef\tpath.ts\n");
        stdout.push(null);
        child.emit("close", 0);
      });
      return child;
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(getChurnStats(join(process.cwd(), "package.json"))).resolves.toEqual({
      additions: 0,
      deletions: 0,
      total: 0,
    });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("skipping malformed numstat record"),
    );
  });
});
