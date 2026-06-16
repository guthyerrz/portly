import { describe, it, expect } from "vitest";
import {
  checkHostResolution,
  extractManagedBlock,
  removeBlock,
  buildBlock,
  shouldAutoSyncHosts,
} from "./hosts.js";

// ---------------------------------------------------------------------------
// extractManagedBlock
// ---------------------------------------------------------------------------

describe("extractManagedBlock", () => {
  it("returns empty array when no markers exist", () => {
    const content = "127.0.0.1 localhost\n::1 localhost\n";
    expect(extractManagedBlock(content)).toEqual([]);
  });

  it("returns empty array when only start marker exists", () => {
    const content = "# portly-start\n127.0.0.1 myapp.localhost\n";
    expect(extractManagedBlock(content)).toEqual([]);
  });

  it("returns empty array when only end marker exists", () => {
    const content = "127.0.0.1 myapp.localhost\n# portly-end\n";
    expect(extractManagedBlock(content)).toEqual([]);
  });

  it("returns empty array when end marker comes before start marker", () => {
    const content = "# portly-end\n127.0.0.1 myapp.localhost\n# portly-start\n";
    expect(extractManagedBlock(content)).toEqual([]);
  });

  it("extracts lines between markers", () => {
    const content = [
      "127.0.0.1 localhost",
      "# portly-start",
      "127.0.0.1 myapp.localhost",
      "127.0.0.1 api.localhost",
      "# portly-end",
      "",
    ].join("\n");
    expect(extractManagedBlock(content)).toEqual([
      "127.0.0.1 myapp.localhost",
      "127.0.0.1 api.localhost",
    ]);
  });

  it("trims whitespace from extracted lines", () => {
    const content = "# portly-start\n  127.0.0.1 myapp.localhost  \n# portly-end\n";
    expect(extractManagedBlock(content)).toEqual(["127.0.0.1 myapp.localhost"]);
  });

  it("filters out empty lines", () => {
    const content = "# portly-start\n\n127.0.0.1 myapp.localhost\n\n# portly-end\n";
    expect(extractManagedBlock(content)).toEqual(["127.0.0.1 myapp.localhost"]);
  });

  it("returns empty array when block is empty", () => {
    const content = "# portly-start\n# portly-end\n";
    expect(extractManagedBlock(content)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// removeBlock
// ---------------------------------------------------------------------------

describe("removeBlock", () => {
  it("returns content unchanged when no markers exist", () => {
    const content = "127.0.0.1 localhost\n";
    expect(removeBlock(content)).toBe("127.0.0.1 localhost\n");
  });

  it("removes the managed block and normalizes newlines", () => {
    const content = [
      "127.0.0.1 localhost",
      "",
      "# portly-start",
      "127.0.0.1 myapp.localhost",
      "# portly-end",
      "",
    ].join("\n");
    const result = removeBlock(content);
    expect(result).not.toContain("portly-start");
    expect(result).not.toContain("myapp.localhost");
    expect(result).toContain("127.0.0.1 localhost");
    expect(result.endsWith("\n")).toBe(true);
  });

  it("does not leave more than 2 consecutive newlines", () => {
    const content =
      "127.0.0.1 localhost\n\n\n# portly-start\n127.0.0.1 x.localhost\n# portly-end\n\n\nother\n";
    const result = removeBlock(content);
    expect(result).not.toMatch(/\n{3,}/);
  });

  it("preserves content before and after the block", () => {
    const content = "before\n# portly-start\nentry\n# portly-end\nafter\n";
    const result = removeBlock(content);
    expect(result).toContain("before");
    expect(result).toContain("after");
  });
});

// ---------------------------------------------------------------------------
// buildBlock
// ---------------------------------------------------------------------------

describe("buildBlock", () => {
  it("returns empty string for empty hostnames array", () => {
    expect(buildBlock([])).toBe("");
  });

  it("builds a single-entry block with markers", () => {
    const result = buildBlock(["myapp.localhost"]);
    expect(result).toBe("# portly-start\n127.0.0.1 myapp.localhost\n# portly-end");
  });

  it("builds a multi-entry block", () => {
    const result = buildBlock(["myapp.localhost", "api.localhost"]);
    const lines = result.split("\n");
    expect(lines[0]).toBe("# portly-start");
    expect(lines[1]).toBe("127.0.0.1 myapp.localhost");
    expect(lines[2]).toBe("127.0.0.1 api.localhost");
    expect(lines[3]).toBe("# portly-end");
  });

  it("produces a block that extractManagedBlock can parse", () => {
    const hostnames = ["a.localhost", "b.localhost"];
    const block = buildBlock(hostnames);
    const extracted = extractManagedBlock(block);
    expect(extracted).toEqual(["127.0.0.1 a.localhost", "127.0.0.1 b.localhost"]);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoSyncHosts
// ---------------------------------------------------------------------------

describe("shouldAutoSyncHosts", () => {
  it("returns true when unset", () => {
    expect(shouldAutoSyncHosts(undefined)).toBe(true);
  });

  it("returns false for 0 and false", () => {
    expect(shouldAutoSyncHosts("0")).toBe(false);
    expect(shouldAutoSyncHosts("false")).toBe(false);
  });

  it("returns true for 1 and true", () => {
    expect(shouldAutoSyncHosts("1")).toBe(true);
    expect(shouldAutoSyncHosts("true")).toBe(true);
  });

  it("returns true for other non-empty values", () => {
    expect(shouldAutoSyncHosts("yes")).toBe(true);
    expect(shouldAutoSyncHosts("")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkHostResolution
// ---------------------------------------------------------------------------

describe("checkHostResolution", () => {
  it("resolves localhost to 127.0.0.1", async () => {
    const result = await checkHostResolution("localhost");
    expect(result).toBe(true);
  });

  it("returns false for a nonexistent domain", async () => {
    const result = await checkHostResolution("this-should-never-exist.invalid");
    expect(result).toBe(false);
  });
});
