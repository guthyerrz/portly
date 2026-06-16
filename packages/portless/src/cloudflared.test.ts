import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildCloudflaredArgs,
  ensureCloudflaredAvailable,
  extractCloudflaredUrl,
  startCloudflared,
  stopCloudflaredProcess,
  type CloudflaredCommandRunner,
  type CloudflaredChildProcess,
  type CloudflaredSpawner,
} from "./cloudflared.js";

class MockCloudflaredChild extends EventEmitter {
  pid = 12345;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedWith: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    return true;
  }
}

function createSpawner(child: MockCloudflaredChild, calls: string[][] = []): CloudflaredSpawner {
  return (args: string[]) => {
    calls.push(args);
    return child as unknown as CloudflaredChildProcess;
  };
}

const QUICK_TUNNEL_BANNER = [
  "2026-06-16T12:00:00Z INF +--------------------------------------------------------------+",
  "2026-06-16T12:00:00Z INF |  Your quick Tunnel has been created! Visit it at:             |",
  "2026-06-16T12:00:00Z INF |  https://random-words-here.trycloudflare.com                  |",
  "2026-06-16T12:00:00Z INF +--------------------------------------------------------------+",
  "",
].join("\n");

describe("cloudflared", () => {
  describe("ensureCloudflaredAvailable", () => {
    it("checks the cloudflared CLI version", () => {
      const calls: string[][] = [];
      const runner: CloudflaredCommandRunner = (args) => {
        calls.push(args);
        return { status: 0, stdout: "cloudflared version 2026.5.0 (built ...)", stderr: "" };
      };

      expect(() => ensureCloudflaredAvailable(runner)).not.toThrow();
      expect(calls).toEqual([["--version"]]);
    });

    it("throws an install hint when the cloudflared CLI is missing", () => {
      const error = Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" });
      const runner: CloudflaredCommandRunner = () => ({
        status: null,
        stdout: "",
        stderr: "",
        error,
      });

      expect(() => ensureCloudflaredAvailable(runner)).toThrow("cloudflared CLI not found");
    });

    it("throws command output when the version check fails", () => {
      const runner: CloudflaredCommandRunner = () => ({
        status: 1,
        stdout: "",
        stderr: "permission denied",
      });

      expect(() => ensureCloudflaredAvailable(runner)).toThrow("permission denied");
    });
  });

  describe("buildCloudflaredArgs", () => {
    it("forwards HTTP traffic to the local app port", () => {
      expect(buildCloudflaredArgs(4123)).toEqual([
        "tunnel",
        "--no-autoupdate",
        "--url",
        "http://127.0.0.1:4123",
      ]);
    });

    it("rewrites the upstream host header when requested", () => {
      expect(buildCloudflaredArgs(4123, "myapp.localhost")).toEqual([
        "tunnel",
        "--no-autoupdate",
        "--url",
        "http://127.0.0.1:4123",
        "--http-host-header=myapp.localhost",
      ]);
    });
  });

  describe("extractCloudflaredUrl", () => {
    it("extracts the quick tunnel URL from the banner", () => {
      expect(extractCloudflaredUrl(QUICK_TUNNEL_BANNER)).toBe(
        "https://random-words-here.trycloudflare.com"
      );
    });

    it("extracts the URL from a structured log line", () => {
      const output =
        "2026-06-16T12:00:00Z INF Registered tunnel connection url=https://abc-def-ghi.trycloudflare.com";
      expect(extractCloudflaredUrl(output)).toBe("https://abc-def-ghi.trycloudflare.com");
    });

    it("returns null when no quick tunnel URL is present", () => {
      const output = "2026-06-16T12:00:00Z ERR failed to request quick Tunnel: 429";
      expect(extractCloudflaredUrl(output)).toBeNull();
    });
  });

  describe("startCloudflared", () => {
    it("spawns cloudflared and resolves with the public URL", async () => {
      const child = new MockCloudflaredChild();
      const calls: string[][] = [];
      const promise = startCloudflared(4123, {
        hostHeader: "myapp.localhost",
        spawner: createSpawner(child, calls),
        timeoutMs: 1000,
      });

      child.stderr.write(QUICK_TUNNEL_BANNER);

      await expect(promise).resolves.toMatchObject({
        url: "https://random-words-here.trycloudflare.com",
        pid: 12345,
      });
      expect(calls).toEqual([
        [
          "tunnel",
          "--no-autoupdate",
          "--url",
          "http://127.0.0.1:4123",
          "--http-host-header=myapp.localhost",
        ],
      ]);
    });

    it("notifies when cloudflared exits after startup", async () => {
      const child = new MockCloudflaredChild();
      const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
      const promise = startCloudflared(4123, {
        onExit: (code, signal) => exits.push({ code, signal }),
        spawner: createSpawner(child),
        timeoutMs: 1000,
      });

      child.stderr.write(QUICK_TUNNEL_BANNER);

      await expect(promise).resolves.toMatchObject({
        url: "https://random-words-here.trycloudflare.com",
      });
      child.emit("exit", 0, null);
      expect(exits).toEqual([{ code: 0, signal: null }]);
    });

    it("throws an install hint when the cloudflared CLI is missing", async () => {
      const error = Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" });
      const spawner: CloudflaredSpawner = () => {
        throw error;
      };

      await expect(startCloudflared(4123, { spawner })).rejects.toThrow(
        "cloudflared CLI not found"
      );
    });

    it("throws a rate-limit hint when cloudflared exits while throttled", async () => {
      const child = new MockCloudflaredChild();
      const promise = startCloudflared(4123, {
        spawner: createSpawner(child),
        timeoutMs: 1000,
      });

      child.stderr.write("2026-06-16T12:00:00Z ERR failed to request quick Tunnel: 429\n");
      child.emit("exit", 1, null);

      await expect(promise).rejects.toThrow("rate-limited");
    });

    it("kills cloudflared when no public URL appears before the timeout", async () => {
      const child = new MockCloudflaredChild();
      const promise = startCloudflared(4123, {
        spawner: createSpawner(child),
        timeoutMs: 1,
      });

      await expect(promise).rejects.toThrow("Timed out waiting for cloudflared");
      expect(child.killedWith).toBe("SIGTERM");
    });
  });

  describe("stopCloudflaredProcess", () => {
    it("terminates the child process", () => {
      const child = new MockCloudflaredChild();
      stopCloudflaredProcess(child as unknown as CloudflaredChildProcess);
      expect(child.killedWith).toBe("SIGTERM");
    });
  });
});
