import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The state directory used by the pre-rename `portless` CLI. */
export const LEGACY_STATE_DIR = path.join(os.homedir(), ".portless");

/** Legacy /etc/hosts block markers written by `portless`. */
const LEGACY_MARKER_START = "# portless-start";
const LEGACY_MARKER_END = "# portless-end";

/** Current markers written by `portly` (kept in sync with hosts.ts). */
const MARKER_START = "# portly-start";
const MARKER_END = "# portly-end";

/**
 * Durable state files worth importing: the local CA, its key, and the
 * generated server certs + proxy config preferences. Runtime files (routes,
 * locks, pids, logs, the live proxy port) are intentionally excluded — they
 * belong to the old process and would be stale.
 */
export const DURABLE_STATE_FILES = [
  "ca.pem",
  "ca-key.pem",
  "ca.srl",
  "server.pem",
  "server-key.pem",
  "server.csr",
  "server-ext.cnf",
  "proxy.tls",
  "proxy.tld",
  "proxy.lan",
] as const;

export interface StateMigrationResult {
  /** Files copied into the destination state dir. */
  copied: string[];
  /** Durable files that already existed at the destination (left untouched). */
  skipped: string[];
}

/**
 * Copy durable state files from `oldDir` to `newDir`. Existing destination
 * files are left untouched unless `force` is set. Only touches the two
 * directories given, so it is safe to unit-test against temp dirs.
 */
export function migrateStateDir(
  oldDir: string,
  newDir: string,
  options: { force?: boolean } = {}
): StateMigrationResult {
  const copied: string[] = [];
  const skipped: string[] = [];
  fs.mkdirSync(newDir, { recursive: true });
  for (const file of DURABLE_STATE_FILES) {
    const src = path.join(oldDir, file);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(newDir, file);
    if (fs.existsSync(dest) && !options.force) {
      skipped.push(file);
      continue;
    }
    fs.copyFileSync(src, dest);
    copied.push(file);
  }
  return { copied, skipped };
}

function indexOfBlock(content: string, start: string, end: string): [number, number] | null {
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  if (s === -1 || e === -1 || e <= s) return null;
  return [s, e + end.length];
}

function removeBlock(content: string, start: string, end: string): string {
  const range = indexOfBlock(content, start, end);
  if (!range) return content;
  return content.slice(0, range[0]) + content.slice(range[1]);
}

function blockHostnames(content: string, start: string, end: string): string[] {
  const range = indexOfBlock(content, start, end);
  if (!range) return [];
  return content
    .slice(content.indexOf(start) + start.length, content.indexOf(end))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1] ?? "")
    .filter(Boolean);
}

export interface HostsMigrationResult {
  content: string;
  hostnames: string[];
  changed: boolean;
}

/**
 * Rewrite a legacy `portless` hosts block to `portly` markers, preserving the
 * managed hostname entries. If a `portly` block already exists, the legacy
 * hostnames are merged into it. Pure string transform — no I/O.
 */
export function migrateHostsContent(content: string): HostsMigrationResult {
  if (!content.includes(LEGACY_MARKER_START)) {
    return {
      content,
      hostnames: blockHostnames(content, MARKER_START, MARKER_END),
      changed: false,
    };
  }

  const legacy = blockHostnames(content, LEGACY_MARKER_START, LEGACY_MARKER_END);
  const existing = blockHostnames(content, MARKER_START, MARKER_END);
  const merged = [...new Set([...existing, ...legacy])];

  let stripped = removeBlock(content, LEGACY_MARKER_START, LEGACY_MARKER_END);
  stripped = removeBlock(stripped, MARKER_START, MARKER_END);
  stripped = stripped.replace(/\n{3,}/g, "\n\n").trimEnd();

  if (merged.length === 0) {
    return { content: `${stripped}\n`, hostnames: [], changed: true };
  }
  const block = `${MARKER_START}\n${merged.map((h) => `127.0.0.1 ${h}`).join("\n")}\n${MARKER_END}`;
  return { content: `${stripped}\n\n${block}\n`, hostnames: merged, changed: true };
}

/**
 * Non-comment lines in a shell rc / .env file that reference the old
 * `PORTLESS_*` environment variables. Used to advise (not rewrite).
 */
export function findLegacyEnvLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => /\bPORTLESS_[A-Z0-9_]+/.test(line) && !line.trim().startsWith("#"))
    .map((line) => line.trim());
}

/** Suggest the `PORTLY_*` form of a `PORTLESS_*` line (display only). */
export function suggestEnvReplacement(line: string): string {
  return line.replace(/PORTLESS_/g, "PORTLY_");
}
