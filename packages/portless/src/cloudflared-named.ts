import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  CloudflaredChildProcess,
  CloudflaredCommandRunner,
  CloudflaredSpawner,
} from "./cloudflared.js";

const CLOUDFLARED_BINARY = "cloudflared";
const NAMED_RUN_TIMEOUT_MS = 45_000;
const NAMED_COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_BUFFER_LIMIT = 16_384;

/** Deterministic prefix so portly-managed tunnels are recognizable in the dashboard. */
const TUNNEL_NAME_PREFIX = "portly-";

const LOGIN_HINT =
  "Not logged in to Cloudflare. Run `portless tunnel login` to authorize a domain, " +
  "then try again.";

interface CloudflaredCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface NamedTunnel {
  name: string;
  id: string;
}

export interface StartedNamedTunnel {
  url: string;
  hostname: string;
  tunnelName: string;
  pid?: number;
  child: CloudflaredChildProcess;
}

export interface StartNamedTunnelOptions {
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  spawner?: CloudflaredSpawner;
  timeoutMs?: number;
}

interface CloudflaredTunnelListEntry {
  id?: string;
  name?: string;
  deleted_at?: string | null;
}

function defaultRunner(args: string[]): CloudflaredCommandResult {
  const result = spawnSync(CLOUDFLARED_BINARY, args, {
    encoding: "utf-8",
    killSignal: "SIGKILL",
    timeout: NAMED_COMMAND_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function defaultSpawner(args: string[]): CloudflaredChildProcess {
  return spawn(CLOUDFLARED_BINARY, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as CloudflaredChildProcess;
}

function normalizeSpace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function formatSpawnError(error: Error): Error {
  const errno = error as NodeJS.ErrnoException;
  if (errno.code === "ENOENT") {
    return new Error(
      "cloudflared CLI not found. Install cloudflared " +
        "(https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) " +
        "and ensure `cloudflared` is on PATH."
    );
  }
  return new Error(`Failed to run cloudflared: ${error.message}`);
}

/** Path to the origin certificate written by `cloudflared tunnel login`. */
export function originCertPath(): string {
  if (process.env.TUNNEL_ORIGIN_CERT) return process.env.TUNNEL_ORIGIN_CERT;
  return path.join(os.homedir(), ".cloudflared", "cert.pem");
}

/** Whether `cloudflared tunnel login` has been completed on this machine. */
export function isLoggedIn(certPath: string = originCertPath()): boolean {
  try {
    return fs.existsSync(certPath);
  } catch {
    return false;
  }
}

export function ensureLoggedIn(certPath: string = originCertPath()): void {
  if (!isLoggedIn(certPath)) {
    throw new Error(LOGIN_HINT);
  }
}

/**
 * Run the interactive `cloudflared tunnel login` flow. Inherits stdio so the
 * user sees the authorization URL and can complete it in the browser. Blocks
 * until cloudflared exits, then verifies the origin certificate was written.
 */
export function loginCloudflared(options: { certPath?: string } = {}): { certPath: string } {
  const certPath = options.certPath ?? originCertPath();
  const result = spawnSync(CLOUDFLARED_BINARY, ["tunnel", "login"], {
    stdio: "inherit",
  });
  if (result.error) {
    throw formatSpawnError(result.error);
  }
  if (result.status !== 0) {
    throw new Error(
      `cloudflared login exited with code ${result.status ?? "unknown"}. ` +
        "Re-run `portless tunnel login` to authorize a domain."
    );
  }
  if (!isLoggedIn(certPath)) {
    throw new Error(
      "cloudflared login finished but no origin certificate was found. " +
        "Make sure you selected a domain in the browser, then try again."
    );
  }
  return { certPath };
}

/**
 * Derive a deterministic, valid cloudflared tunnel name from a public
 * hostname. The same hostname always maps to the same tunnel so runs reuse
 * the existing tunnel and DNS record instead of churning them.
 */
export function tunnelNameForHostname(hostname: string): string {
  const slug = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${TUNNEL_NAME_PREFIX}${slug}`;
}

function parseTunnelList(raw: string): CloudflaredTunnelListEntry[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CloudflaredTunnelListEntry[]) : [];
  } catch {
    return [];
  }
}

function isDeleted(entry: CloudflaredTunnelListEntry): boolean {
  const deletedAt = entry.deleted_at;
  if (!deletedAt) return false;
  // cloudflared emits the Go zero-value timestamp ("0001-01-01T00:00:00Z") for
  // ACTIVE tunnels — only a real, later timestamp means the tunnel is deleted.
  return !deletedAt.startsWith("0001-01-01");
}

function findTunnelId(entries: CloudflaredTunnelListEntry[], name: string): string | undefined {
  const match = entries.find((entry) => entry.name === name && !isDeleted(entry));
  return match?.id;
}

function runOrThrow(
  args: string[],
  action: string,
  runner: CloudflaredCommandRunner
): CloudflaredCommandResult {
  const result = runner(args);
  if (result.error) {
    throw formatSpawnError(result.error);
  }
  if (result.status !== 0) {
    const details = normalizeSpace(result.stderr || result.stdout);
    const lower = details.toLowerCase();
    if (
      lower.includes("cert.pem") ||
      lower.includes("origin certificate") ||
      lower.includes("not logged in") ||
      lower.includes("please login")
    ) {
      throw new Error(LOGIN_HINT);
    }
    throw new Error(`Failed to ${action}: ${details || "unknown cloudflared error"}`);
  }
  return result;
}

/**
 * Create the named tunnel for `hostname`, or reuse it if it already exists.
 * Idempotent: safe to call on every run.
 */
export function ensureNamedTunnel(
  hostname: string,
  options: { runner?: CloudflaredCommandRunner } = {}
): NamedTunnel {
  const runner = options.runner ?? defaultRunner;
  const name = tunnelNameForHostname(hostname);

  const listResult = runOrThrow(
    ["tunnel", "list", "--output", "json"],
    "list cloudflare tunnels",
    runner
  );
  const existingId = findTunnelId(parseTunnelList(listResult.stdout), name);
  if (existingId) {
    return { name, id: existingId };
  }

  const createResult = runOrThrow(["tunnel", "create", name], "create cloudflare tunnel", runner);
  const idMatch = createResult.stdout.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  if (idMatch) {
    return { name, id: idMatch[0] };
  }

  // Fall back to a fresh list if the create output format changed.
  const relist = runOrThrow(
    ["tunnel", "list", "--output", "json"],
    "list cloudflare tunnels",
    runner
  );
  const id = findTunnelId(parseTunnelList(relist.stdout), name);
  if (!id) {
    throw new Error(`Created cloudflare tunnel "${name}" but could not determine its id.`);
  }
  return { name, id };
}

/**
 * Point `hostname` at the tunnel via a proxied CNAME. `--overwrite-dns` makes
 * this idempotent across runs and lets it reclaim a record from a prior tunnel.
 */
export function ensureDnsRoute(
  tunnelName: string,
  hostname: string,
  options: { runner?: CloudflaredCommandRunner } = {}
): void {
  const runner = options.runner ?? defaultRunner;
  const result = runner(["tunnel", "route", "dns", "--overwrite-dns", tunnelName, hostname]);
  if (result.error) {
    throw formatSpawnError(result.error);
  }
  if (result.status !== 0) {
    const details = normalizeSpace(result.stderr || result.stdout);
    const lower = details.toLowerCase();
    if (
      lower.includes("zone") &&
      (lower.includes("not found") || lower.includes("not authorized"))
    ) {
      throw new Error(
        `Cloudflare has no authorized zone for ${hostname}. ` +
          "Run `portless tunnel login` and select the domain that owns this hostname."
      );
    }
    throw new Error(`Failed to route ${hostname} to the tunnel: ${details || "unknown error"}`);
  }
}

export function buildNamedRunArgs(tunnelName: string, localPort: number): string[] {
  // Flag order matters: per `cloudflared tunnel --help` the usage is
  // `tunnel [tunnel command options] run [subcommand options] [TUNNEL]`.
  // `--no-autoupdate` is a tunnel-command option, so it must come BEFORE `run`;
  // `--url` is a run subcommand option, so it must come AFTER. Putting
  // `--no-autoupdate` after `run` makes cloudflared dump help and exit 0.
  return ["tunnel", "--no-autoupdate", "run", "--url", `http://127.0.0.1:${localPort}`, tunnelName];
}

function formatRunExitError(output: string): Error {
  const details = normalizeSpace(output);
  const lower = details.toLowerCase();
  // Match only phrases that appear in genuine auth errors — not the word
  // "login"/"cert.pem" alone, which also appear in cloudflared's help text.
  if (
    lower.includes("not logged in") ||
    lower.includes("cannot determine default origin") ||
    lower.includes("you need to login")
  ) {
    return new Error(LOGIN_HINT);
  }
  if (lower.includes("tunnel not found") || lower.includes("couldn't find tunnel")) {
    return new Error(
      "cloudflared could not find the named tunnel. Provisioning may have failed; try again."
    );
  }
  return new Error(
    `Failed to start the named cloudflare tunnel: ${details || "cloudflared exited before connecting"}`
  );
}

function looksReady(output: string): boolean {
  return /registered tunnel connection/i.test(output) || /connection .+ registered/i.test(output);
}

/**
 * Spawn `cloudflared tunnel run` for an already-provisioned tunnel and resolve
 * once the edge connection is registered. Unlike the quick tunnel, the public
 * URL is known up front (`https://<hostname>`), so we wait on connection
 * readiness rather than parsing a URL.
 */
export function startNamedTunnel(
  tunnel: NamedTunnel,
  localPort: number,
  hostname: string,
  options: StartNamedTunnelOptions = {}
): Promise<StartedNamedTunnel> {
  const spawner = options.spawner ?? defaultSpawner;
  const timeoutMs = options.timeoutMs ?? NAMED_RUN_TIMEOUT_MS;
  const args = buildNamedRunArgs(tunnel.name, localPort);

  let child: CloudflaredChildProcess;
  try {
    child = spawner(args);
  } catch (err: unknown) {
    return Promise.reject(formatSpawnError(err instanceof Error ? err : new Error(String(err))));
  }

  const url = `https://${hostname}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let started = false;
    let output = "";

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const appendOutput = (chunk: Buffer | string) => {
      if (settled) return;
      output += chunk.toString();
      if (output.length > OUTPUT_BUFFER_LIMIT) {
        output = output.slice(-OUTPUT_BUFFER_LIMIT);
      }
      if (looksReady(output)) {
        settle(() => {
          started = true;
          resolve({ url, hostname, tunnelName: tunnel.name, pid: child.pid, child });
        });
      }
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // non-fatal
      }
      settle(() =>
        reject(
          new Error(
            "Timed out waiting for the named cloudflare tunnel to connect. " +
              "Check your network and that the tunnel is provisioned correctly."
          )
        )
      );
    }, timeoutMs);

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("error", (err) => {
      settle(() => reject(formatSpawnError(err)));
    });
    child.on("exit", (code, signal) => {
      if (settled) {
        if (started) options.onExit?.(code, signal);
        return;
      }
      settle(() => {
        const suffix = signal ? ` (signal ${signal})` : code !== null ? ` (exit ${code})` : "";
        const error = formatRunExitError(output);
        reject(new Error(`${error.message}${suffix}`));
      });
    });
  });
}

export function stopNamedTunnelProcess(child: CloudflaredChildProcess | undefined): void {
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Best-effort cleanup.
  }
}

export function stopNamedTunnel(route: { cloudflaredPid?: number }): void {
  if (!route.cloudflaredPid) return;
  try {
    process.kill(route.cloudflaredPid, "SIGTERM");
  } catch {
    // Process may already be gone, or may belong to another user.
  }
}

/**
 * Permanently delete a named tunnel. Clears stale edge connections first, then
 * deletes the tunnel. The DNS CNAME is left in place (cloudflared cannot remove
 * DNS records from the CLI); callers should warn the user about that.
 */
export function deleteNamedTunnel(
  tunnelName: string,
  options: { runner?: CloudflaredCommandRunner } = {}
): void {
  const runner = options.runner ?? defaultRunner;
  // Best-effort: clearing stale connections lets delete succeed.
  runner(["tunnel", "cleanup", tunnelName]);
  const result = runner(["tunnel", "delete", tunnelName]);
  if (result.error) {
    throw formatSpawnError(result.error);
  }
  if (result.status !== 0) {
    const details = normalizeSpace(result.stderr || result.stdout);
    const lower = details.toLowerCase();
    if (lower.includes("active connection")) {
      throw new Error(
        `Tunnel "${tunnelName}" still has active connections. Stop the app first, then retry.`
      );
    }
    throw new Error(`Failed to delete tunnel "${tunnelName}": ${details || "unknown error"}`);
  }
}
