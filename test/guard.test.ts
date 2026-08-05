import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "bun:test";

import { guardPaths, renderGuardReport, scanText } from "../src/guard.ts";
import { run } from "../src/cli.ts";

describe("LastSecrets guard", () => {
  it("reports redacted findings with line and column", () => {
    const text = "safe\napi_key = ghp_" + "a".repeat(36) + "\n";
    const findings = scanText("notes.md", text);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("notes.md");
    expect(findings[0]!.line).toBe(2);
    expect(findings[0]!.column).toBe(11);
    expect(findings[0]!.preview).toBe("api_key = <redacted>");
    expect(findings[0]!.preview).not.toContain("ghp_");
  });

  it("ignores lastsecrets locators and env placeholders", () => {
    const findings = scanText(
      "runbook.md",
      "token = lastsecrets://ci-deploy\npassword = ${DEPLOY_PASSWORD}\n",
    );

    expect(findings).toEqual([]);
  });

  it("walks files and skips vendor-like directories", () => {
    const root = mkdtempSync(join(tmpdir(), "lastsecrets-guard-"));
    writeFileSync(join(root, "README.md"), "credential = reviewThisValue123\n");
    writeFileSync(join(root, "bun.lock"), "token = reviewThisValue123\n");

    const findings = guardPaths([root]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toContain("README.md");
    expect(findings[0]!.confidence).toBe("uncertain");
  });

  it("CLI fails closed on likely raw secret persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "lastsecrets-guard-cli-"));
    writeFileSync(join(root, "notes.md"), "password = reviewThisValue123\n");
    const io = captureIo("");

    const code = await run(["guard", root], io);

    expect(code).toBe(1);
    expect(io.out()).toContain("lastsecrets guard: likely raw secret persistence found");
    expect(io.out()).toContain("<redacted>");
    expect(io.out()).not.toContain("reviewThisValue123");
  });

  it("CLI passes clean paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "lastsecrets-guard-clean-"));
    writeFileSync(join(root, "notes.md"), "token = lastsecrets://deploy-token\n");
    const io = captureIo("");

    const code = await run(["guard", root], io);

    expect(code).toBe(0);
    expect(io.out()).toContain("no likely raw secret persistence found");
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
