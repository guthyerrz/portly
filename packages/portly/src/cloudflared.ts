import { spawn, spawnSync } from "node:child_process";

const CLOUDFLARED_BINARY = "cloudflared";
const CLOUDFLARED_START_TIMEOUT_MS = 30_000;
const CLOUDFLARED_COMMAND_TIMEOUT_MS = 10_000;
const OUTPUT_BUFFER_LIMIT = 16_384;

const INSTALL_HINT =
  "cloudflared CLI not found. Install cloudflared " +
  "(https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) " +
  "and ensure `cloudflared` is on PATH.";

export interface CloudflaredChildProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type CloudflaredSpawner = (args: string[]) => CloudflaredChildProcess;

interface CloudflaredCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CloudflaredCommandRunner = (args: string[]) => CloudflaredCommandResult;

export interface StartCloudflaredOptions {
  hostHeader?: string;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  spawner?: CloudflaredSpawner;
  timeoutMs?: number;
}

export interface StartedCloudflared {
  url: string;
  pid?: number;
  child: CloudflaredChildProcess;
}

function defaultSpawner(args: string[]): CloudflaredChildProcess {
  return spawn(CLOUDFLARED_BINARY, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as CloudflaredChildProcess;
}

function defaultRunner(args: string[]): CloudflaredCommandResult {
  const result = spawnSync(CLOUDFLARED_BINARY, args, {
    encoding: "utf-8",
    killSignal: "SIGKILL",
    timeout: CLOUDFLARED_COMMAND_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function normalizeSpace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function formatSpawnError(error: Error): Error {
  const errno = error as NodeJS.ErrnoException;
  if (errno.code === "ENOENT") {
    return new Error(INSTALL_HINT);
  }
  return new Error(`Failed to start cloudflared: ${error.message}`);
}

function formatOutputError(output: string): Error {
  const details = normalizeSpace(output);
  const lower = details.toLowerCase();
  if (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("failed to request quick tunnel") ||
    lower.includes("rate limit")
  ) {
    return new Error(
      "cloudflared could not create a quick tunnel because Cloudflare rate-limited the request. " +
        "Quick tunnels (*.trycloudflare.com) are throttled; wait a moment and try again, or use a " +
        "named Cloudflare tunnel for stable hostnames."
    );
  }
  return new Error(
    `Failed to start cloudflared tunnel: ${details || "cloudflared exited before printing a public URL"}`
  );
}

export function ensureCloudflaredAvailable(runner: CloudflaredCommandRunner = defaultRunner): void {
  const result = runner(["--version"]);
  if (result.error) {
    throw formatSpawnError(result.error);
  }
  if (result.status !== 0) {
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(
      `Failed to check cloudflared version: ${details || "unknown cloudflared error"}`
    );
  }
}

function cleanUrl(value: string): string {
  return value.replace(/[),.|]+$/g, "");
}

/**
 * Parse the anonymous quick-tunnel URL from cloudflared's log stream.
 * cloudflared prints a boxed banner to stderr containing the assigned
 * `https://<random-words>.trycloudflare.com` hostname.
 */
export function extractCloudflaredUrl(output: string): string | null {
  const matches = output.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com[^\s"'<>|]*/gi);
  for (const match of matches) {
    const candidate = cleanUrl(match[0]);
    try {
      const parsed = new URL(candidate);
      if (!parsed.hostname.toLowerCase().endsWith(".trycloudflare.com")) continue;
      return parsed.toString().replace(/\/$/, "");
    } catch {
      continue;
    }
  }
  return null;
}

export function buildCloudflaredArgs(localPort: number, hostHeader?: string): string[] {
  const args = ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${localPort}`];
  if (hostHeader) {
    args.push(`--http-host-header=${hostHeader}`);
  }
  return args;
}

export function startCloudflared(
  localPort: number,
  options: StartCloudflaredOptions = {}
): Promise<StartedCloudflared> {
  const spawner = options.spawner ?? defaultSpawner;
  const timeoutMs = options.timeoutMs ?? CLOUDFLARED_START_TIMEOUT_MS;
  const args = buildCloudflaredArgs(localPort, options.hostHeader);

  let child: CloudflaredChildProcess;
  try {
    child = spawner(args);
  } catch (err: unknown) {
    return Promise.reject(formatSpawnError(err instanceof Error ? err : new Error(String(err))));
  }

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
      const url = extractCloudflaredUrl(output);
      if (url) {
        settle(() => {
          started = true;
          resolve({ url, pid: child.pid, child });
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
            "Timed out waiting for cloudflared to print a public URL. " +
              "Check that cloudflared can reach the Cloudflare edge."
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
        const error = formatOutputError(output);
        reject(new Error(`${error.message}${suffix}`));
      });
    });
  });
}

export function stopCloudflaredProcess(child: CloudflaredChildProcess | undefined): void {
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Best-effort cleanup.
  }
}

export function stopCloudflared(route: { cloudflaredPid?: number }): void {
  if (!route.cloudflaredPid) return;
  try {
    process.kill(route.cloudflaredPid, "SIGTERM");
  } catch {
    // Process may already be gone, or may belong to another user.
  }
}
