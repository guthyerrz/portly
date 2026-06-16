import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildNamedRunArgs,
  deleteNamedTunnel,
  ensureDnsRoute,
  ensureNamedTunnel,
  startNamedTunnel,
  stopNamedTunnelProcess,
  tunnelNameForHostname,
  type NamedTunnel,
} from "./cloudflared-named.js";
import type {
  CloudflaredChildProcess,
  CloudflaredCommandRunner,
  CloudflaredSpawner,
} from "./cloudflared.js";

class MockChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedWith: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    return true;
  }
}

function createSpawner(child: MockChild, calls: string[][] = []): CloudflaredSpawner {
  return (args: string[]) => {
    calls.push(args);
    return child as unknown as CloudflaredChildProcess;
  };
}

const TUNNEL_ID = "12345678-90ab-cdef-1234-567890abcdef";
const READY_LOG =
  "2026-06-16T12:00:00Z INF Registered tunnel connection connIndex=0 connection=abc\n";

describe("cloudflared-named", () => {
  describe("tunnelNameForHostname", () => {
    it("derives a deterministic, sanitized tunnel name", () => {
      expect(tunnelNameForHostname("stripe-hooks.user.com")).toBe("portly-stripe-hooks-user-com");
      expect(tunnelNameForHostname("API.Example.COM")).toBe("portly-api-example-com");
    });
  });

  describe("ensureNamedTunnel", () => {
    it("reuses an existing tunnel when one is already provisioned", () => {
      const calls: string[][] = [];
      const runner: CloudflaredCommandRunner = (args) => {
        calls.push(args);
        return {
          status: 0,
          stdout: JSON.stringify([
            // cloudflared emits this zero-value timestamp for ACTIVE tunnels.
            { id: TUNNEL_ID, name: "portly-app-user-com", deleted_at: "0001-01-01T00:00:00Z" },
          ]),
          stderr: "",
        };
      };

      const tunnel = ensureNamedTunnel("app.user.com", { runner });
      expect(tunnel).toEqual({ name: "portly-app-user-com", id: TUNNEL_ID });
      // Only lists; never creates.
      expect(calls).toEqual([["tunnel", "list", "--output", "json"]]);
    });

    it("creates a tunnel when none exists and parses the new id", () => {
      const calls: string[][] = [];
      const runner: CloudflaredCommandRunner = (args) => {
        calls.push(args);
        if (args[1] === "list") {
          return { status: 0, stdout: "[]", stderr: "" };
        }
        return {
          status: 0,
          stdout: `Created tunnel portly-app-user-com with id ${TUNNEL_ID}`,
          stderr: "",
        };
      };

      const tunnel = ensureNamedTunnel("app.user.com", { runner });
      expect(tunnel).toEqual({ name: "portly-app-user-com", id: TUNNEL_ID });
      expect(calls).toEqual([
        ["tunnel", "list", "--output", "json"],
        ["tunnel", "create", "portly-app-user-com"],
      ]);
    });

    it("surfaces a login hint when the origin certificate is missing", () => {
      const runner: CloudflaredCommandRunner = () => ({
        status: 1,
        stdout: "",
        stderr: "Cannot determine default origin certificate path. No file cert.pem",
      });

      expect(() => ensureNamedTunnel("app.user.com", { runner })).toThrow("tunnel login");
    });
  });

  describe("ensureDnsRoute", () => {
    it("routes the hostname with --overwrite-dns for idempotency", () => {
      const calls: string[][] = [];
      const runner: CloudflaredCommandRunner = (args) => {
        calls.push(args);
        return { status: 0, stdout: "Added CNAME app.user.com", stderr: "" };
      };

      ensureDnsRoute("portly-app-user-com", "app.user.com", { runner });
      expect(calls).toEqual([
        ["tunnel", "route", "dns", "--overwrite-dns", "portly-app-user-com", "app.user.com"],
      ]);
    });

    it("explains when no authorized zone owns the hostname", () => {
      const runner: CloudflaredCommandRunner = () => ({
        status: 1,
        stdout: "",
        stderr: "Failed to add route: zone for app.other.com not found",
      });

      expect(() => ensureDnsRoute("portly-app-other-com", "app.other.com", { runner })).toThrow(
        "no authorized zone"
      );
    });
  });

  describe("buildNamedRunArgs", () => {
    it("runs the named tunnel against the local app port", () => {
      expect(buildNamedRunArgs("portly-app-user-com", 4123)).toEqual([
        "tunnel",
        "--no-autoupdate",
        "run",
        "--url",
        "http://127.0.0.1:4123",
        "portly-app-user-com",
      ]);
    });
  });

  describe("startNamedTunnel", () => {
    const tunnel: NamedTunnel = { name: "portly-app-user-com", id: TUNNEL_ID };

    it("resolves with the known hostname once a connection registers", async () => {
      const child = new MockChild();
      const calls: string[][] = [];
      const promise = startNamedTunnel(tunnel, 4123, "app.user.com", {
        spawner: createSpawner(child, calls),
        timeoutMs: 1000,
      });

      child.stderr.write(READY_LOG);

      await expect(promise).resolves.toMatchObject({
        url: "https://app.user.com",
        hostname: "app.user.com",
        tunnelName: "portly-app-user-com",
        pid: 4242,
      });
      expect(calls).toEqual([
        [
          "tunnel",
          "--no-autoupdate",
          "run",
          "--url",
          "http://127.0.0.1:4123",
          "portly-app-user-com",
        ],
      ]);
    });

    it("notifies when the tunnel exits after connecting", async () => {
      const child = new MockChild();
      const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
      const promise = startNamedTunnel(tunnel, 4123, "app.user.com", {
        onExit: (code, signal) => exits.push({ code, signal }),
        spawner: createSpawner(child),
        timeoutMs: 1000,
      });

      child.stderr.write(READY_LOG);
      await expect(promise).resolves.toMatchObject({ url: "https://app.user.com" });
      child.emit("exit", 0, null);
      expect(exits).toEqual([{ code: 0, signal: null }]);
    });

    it("surfaces a login hint when the tunnel exits unauthenticated", async () => {
      const child = new MockChild();
      const promise = startNamedTunnel(tunnel, 4123, "app.user.com", {
        spawner: createSpawner(child),
        timeoutMs: 1000,
      });

      child.stderr.write("ERR Cannot determine default origin certificate path cert.pem\n");
      child.emit("exit", 1, null);

      await expect(promise).rejects.toThrow("tunnel login");
    });

    it("times out and kills the process when no connection registers", async () => {
      const child = new MockChild();
      const promise = startNamedTunnel(tunnel, 4123, "app.user.com", {
        spawner: createSpawner(child),
        timeoutMs: 1,
      });

      await expect(promise).rejects.toThrow("Timed out waiting for the named cloudflare tunnel");
      expect(child.killedWith).toBe("SIGTERM");
    });
  });

  describe("deleteNamedTunnel", () => {
    it("cleans up stale connections then deletes", () => {
      const calls: string[][] = [];
      const runner: CloudflaredCommandRunner = (args) => {
        calls.push(args);
        return { status: 0, stdout: "Deleted tunnel", stderr: "" };
      };

      deleteNamedTunnel("portly-app-user-com", { runner });
      expect(calls).toEqual([
        ["tunnel", "cleanup", "portly-app-user-com"],
        ["tunnel", "delete", "portly-app-user-com"],
      ]);
    });

    it("explains when the tunnel still has active connections", () => {
      const runner: CloudflaredCommandRunner = (args) => {
        if (args[1] === "cleanup") return { status: 0, stdout: "", stderr: "" };
        return { status: 1, stdout: "", stderr: "tunnel has active connections" };
      };

      expect(() => deleteNamedTunnel("portly-app-user-com", { runner })).toThrow(
        "active connections"
      );
    });
  });

  describe("stopNamedTunnelProcess", () => {
    it("terminates the child process", () => {
      const child = new MockChild();
      stopNamedTunnelProcess(child as unknown as CloudflaredChildProcess);
      expect(child.killedWith).toBe("SIGTERM");
    });
  });
});
