import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DURABLE_STATE_FILES,
  findLegacyEnvLines,
  migrateHostsContent,
  migrateStateDir,
  suggestEnvReplacement,
} from "./migrate.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "portly-migrate-test-"));
}

describe("migrateStateDir", () => {
  let oldDir: string;
  let newDir: string;

  beforeEach(() => {
    oldDir = tmp();
    newDir = tmp();
  });

  afterEach(() => {
    fs.rmSync(oldDir, { recursive: true, force: true });
    fs.rmSync(newDir, { recursive: true, force: true });
  });

  it("copies durable files and skips runtime files", () => {
    // Durable
    fs.writeFileSync(path.join(oldDir, "ca.pem"), "CA");
    fs.writeFileSync(path.join(oldDir, "ca-key.pem"), "KEY");
    fs.writeFileSync(path.join(oldDir, "proxy.tld"), "test");
    // Runtime (must NOT be copied)
    fs.writeFileSync(path.join(oldDir, "routes.json"), "[]");
    fs.writeFileSync(path.join(oldDir, "proxy.pid"), "999");
    fs.writeFileSync(path.join(oldDir, "proxy.port"), "443");

    const result = migrateStateDir(oldDir, newDir);

    expect(result.copied.sort()).toEqual(["ca-key.pem", "ca.pem", "proxy.tld"]);
    expect(fs.readFileSync(path.join(newDir, "ca.pem"), "utf-8")).toBe("CA");
    expect(fs.existsSync(path.join(newDir, "routes.json"))).toBe(false);
    expect(fs.existsSync(path.join(newDir, "proxy.pid"))).toBe(false);
    expect(fs.existsSync(path.join(newDir, "proxy.port"))).toBe(false);
  });

  it("does not overwrite existing destination files unless forced", () => {
    fs.writeFileSync(path.join(oldDir, "ca.pem"), "OLD");
    fs.writeFileSync(path.join(newDir, "ca.pem"), "EXISTING");

    const skip = migrateStateDir(oldDir, newDir);
    expect(skip.copied).toEqual([]);
    expect(skip.skipped).toEqual(["ca.pem"]);
    expect(fs.readFileSync(path.join(newDir, "ca.pem"), "utf-8")).toBe("EXISTING");

    const forced = migrateStateDir(oldDir, newDir, { force: true });
    expect(forced.copied).toEqual(["ca.pem"]);
    expect(fs.readFileSync(path.join(newDir, "ca.pem"), "utf-8")).toBe("OLD");
  });

  it("only ever touches the allowlisted durable files", () => {
    expect(DURABLE_STATE_FILES).toContain("ca.pem");
    expect(DURABLE_STATE_FILES).not.toContain("routes.json");
    expect(DURABLE_STATE_FILES).not.toContain("proxy.pid");
  });
});

describe("migrateHostsContent", () => {
  it("rewrites a legacy portless block to portly markers, preserving hostnames", () => {
    const input = [
      "127.0.0.1 localhost",
      "",
      "# portless-start",
      "127.0.0.1 myapp.localhost",
      "127.0.0.1 api.localhost",
      "# portless-end",
      "",
    ].join("\n");

    const out = migrateHostsContent(input);

    expect(out.changed).toBe(true);
    expect(out.hostnames).toEqual(["myapp.localhost", "api.localhost"]);
    expect(out.content).toContain("# portly-start");
    expect(out.content).toContain("# portly-end");
    expect(out.content).not.toContain("portless");
    expect(out.content).toContain("127.0.0.1 myapp.localhost");
    // Unmanaged lines are preserved.
    expect(out.content).toContain("127.0.0.1 localhost");
  });

  it("merges legacy hostnames into an existing portly block without duplicates", () => {
    const input = [
      "# portly-start",
      "127.0.0.1 myapp.localhost",
      "# portly-end",
      "# portless-start",
      "127.0.0.1 myapp.localhost",
      "127.0.0.1 legacy.localhost",
      "# portless-end",
    ].join("\n");

    const out = migrateHostsContent(input);

    expect(out.changed).toBe(true);
    expect(out.hostnames).toEqual(["myapp.localhost", "legacy.localhost"]);
    expect(out.content).not.toContain("portless");
    // Single portly block.
    expect(out.content.match(/# portly-start/g)?.length).toBe(1);
  });

  it("is a no-op when there is no legacy block", () => {
    const input = "127.0.0.1 localhost\n# portly-start\n127.0.0.1 x.localhost\n# portly-end\n";
    const out = migrateHostsContent(input);
    expect(out.changed).toBe(false);
    expect(out.content).toBe(input);
  });
});

describe("findLegacyEnvLines / suggestEnvReplacement", () => {
  it("finds non-comment PORTLESS_ lines and suggests PORTLY_ replacements", () => {
    const rc = [
      "export PATH=$PATH:/usr/local/bin",
      "export PORTLESS_TAILSCALE=1",
      "# export PORTLESS_NGROK=1   (commented, ignored)",
      'export PORTLESS_STATE_DIR="$HOME/.portless"',
    ].join("\n");

    const lines = findLegacyEnvLines(rc);
    expect(lines).toEqual([
      "export PORTLESS_TAILSCALE=1",
      'export PORTLESS_STATE_DIR="$HOME/.portless"',
    ]);
    expect(suggestEnvReplacement(lines[0])).toBe("export PORTLY_TAILSCALE=1");
  });

  it("returns nothing when there are no PORTLESS_ references", () => {
    expect(findLegacyEnvLines("export FOO=1\nexport PORTLY_NGROK=1")).toEqual([]);
  });
});
