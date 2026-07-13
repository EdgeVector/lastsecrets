import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.ts";

describe("LastSecrets CLI pure commands", () => {
  it("formats references", async () => {
    const io = captureIo("");
    const code = await run(["ref", "schema-resolver-r2-prod"], io);
    expect(code).toBe(0);
    expect(io.out()).toBe("lastsecrets://schema-resolver-r2-prod\n");
    expect(io.err()).toBe("");
  });

  it("rejects invalid refs without printing a secret", async () => {
    const io = captureIo("sk-live-do-not-print");
    const code = await run(["ref", "../bad"], io);
    expect(code).toBe(1);
    expect(io.err()).toContain("invalid LastSecrets slug");
    expect(io.err()).not.toContain("sk-live-do-not-print");
  });

  it("guards generated fixtures using stdin without echoing the raw value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lastsecrets-guard-"));
    const fixture = join(dir, "migration.plan.log");
    const raw = "sk-live-guard-fixture-value";
    writeFileSync(fixture, "record=brain-note value=<redacted:27 chars>\n", { mode: 0o600 });

    const io = captureIo(raw);
    const code = await run(["guard", "--file", fixture, "--value-stdin"], io);
    expect(code).toBe(0);
    expect(io.out()).toContain("guard ok:");
    expect(io.out()).not.toContain(raw);
    expect(io.err()).toBe("");
  });
});

function captureIo(stdin: string) {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    },
    stdinText: async () => stdin,
    out: () => stdout,
    err: () => stderr,
  };
}
