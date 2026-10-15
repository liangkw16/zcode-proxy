import { describe, it, expect, vi } from "vitest";
import { stopDaemon } from "./stop.js";
import { startBackground } from "./start.js";

function mockChild(pid: number, exitCode: number | null = null): any {
  return {
    pid,
    exitCode,
    unref() {
      return this;
    },
    on() {
      return this;
    },
  };
}

describe("stopDaemon", () => {
  it("returns false and never signals when the pid file is empty", async () => {
    const kill = vi.fn();
    const result = await stopDaemon({
      pidFile: "/tmp/daemon.pid",
      readText: async () => "   ",
      kill,
    });
    expect(result).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("rejects a zero / non-numeric pid instead of killing the process group", async () => {
    const kill = vi.fn();
    for (const raw of ["0", "-1", "abc", "12abc"]) {
      const result = await stopDaemon({
        pidFile: "/tmp/daemon.pid",
        readText: async () => raw,
        kill,
      });
      expect(result).toBe(false);
    }
    expect(kill).not.toHaveBeenCalled();
  });

  it("sends SIGTERM to a valid positive pid", async () => {
    const kill = vi.fn();
    const result = await stopDaemon({
      pidFile: "/tmp/daemon.pid",
      readText: async () => " 1234 \n",
      kill,
    });
    expect(result).toBe(true);
    expect(kill).toHaveBeenCalledWith(1234, "SIGTERM");
  });

  it("returns false when the process is already gone (ESRCH)", async () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    const result = await stopDaemon({
      pidFile: "/tmp/daemon.pid",
      readText: async () => "1234",
      kill,
    });
    expect(result).toBe(false);
  });
});

describe("startBackground", () => {
  const fresh = (overrides: any = {}) => ({
    pidFile: "/tmp/daemon.pid",
    readText: async () => {
      throw Object.assign(new Error("enoent"), { code: "ENOENT" });
    },
    isProcessAlive: () => false,
    spawn: vi.fn(() => mockChild(5678)),
    waitForHealth: vi.fn(async () => true),
    pollIntervalMs: 1,
    timeoutMs: 1000,
    ...overrides,
  });

  it("does not spawn or overwrite the pid when an instance is already running", async () => {
    const spawn = vi.fn();
    const result = await startBackground(8793, {
      ...fresh(),
      readText: async () => "1234",
      isProcessAlive: () => true,
      spawn,
    });
    expect(result.alreadyRunning).toBe(true);
    expect(result.pid).toBe(1234);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns the daemon with the requested port and reports success once healthy", async () => {
    const spawn = vi.fn(() => mockChild(5678));
    const result = await startBackground(
      8793,
      fresh({ spawn, waitForHealth: vi.fn(async () => true) }),
    );
    expect(result.pid).toBe(5678);
    const args = spawn.mock.calls[0][1] as string[];
    expect(args).toContain("daemon");
    expect(args).toContain("--port");
    expect(args).toContain("8793");
  });

  it("fails when the child exits before it starts listening", async () => {
    await expect(
      startBackground(
        8793,
        fresh({ spawn: vi.fn(() => mockChild(5678, 1)), waitForHealth: vi.fn(async () => false) }),
      ),
    ).rejects.toBeTruthy();
  });
});
