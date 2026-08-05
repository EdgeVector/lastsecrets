import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.ts";
import { initSentry, type SentryModule } from "../src/observability/sentry.ts";

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

  it("captures sanitized command failures when Sentry is initialized", async () => {
    const captured: Array<{ error: unknown; tags?: Record<string, string> }> = [];
    const sentryModule: SentryModule = {
      init: () => {},
      captureException: (error, context) => {
        captured.push({ error, tags: context?.tags });
      },
      flush: async () => true,
    };
    await initSentry({
      service: "lastsecrets-cli",
      env: { OBS_SENTRY_DSN: "https://example.invalid/1" },
      sentryModule,
      installProcessHandlers: false,
    });

    const dir = mkdtempSync(join(tmpdir(), "lastsecrets-cli-test-"));
    const io = captureIo("");
    const code = await run(
      ["get", "lastsecrets://prod-api-key", "--config", join(dir, "missing.json")],
      io,
    );
    rmSync(dir, { recursive: true, force: true });

    expect(code).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.tags).toMatchObject({
      service: "lastsecrets-cli",
      entrypoint: "cli",
      command: "get",
    });
    expect(String((captured[0]?.error as Error).message)).not.toContain("prod-api-key");
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
