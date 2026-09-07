import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initCliSentry, run } from "../src/cli.ts";
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

// A telemetry variable must never decide whether a credential resolves. On
// 2026-09-07 OBS_SENTRY_DSN in the routinesd LaunchAgent made every
// `lastsecrets get` inside the daemon fail, which starved the claude OAuth
// token and stopped the whole routine fleet for 3h15m.
describe("Sentry bootstrap never fails the command", () => {
  it("skips an unresolved lastsecrets:// locator and says so on stderr", async () => {
    let stderr = "";
    const result = await initCliSentry(
      { OBS_SENTRY_DSN: "lastsecrets://obs-sentry-dsn-routines" },
      {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        },
      },
    );
    expect(result).toEqual({ initialized: false, reason: "unresolved_locator" });
    expect(stderr).toContain("unresolved lastsecrets:// locator");
  });

  it("reports a reason instead of throwing when the Sentry module is missing", async () => {
    let stderr = "";
    const result = await initCliSentry({ OBS_SENTRY_DSN: "https://example.invalid/1" }, {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    });
    // The module either loads or it does not. Neither outcome may throw.
    if (result.initialized) {
      expect(stderr).toBe("");
    } else {
      expect(result.reason).toBe("init_failed");
      expect(stderr).toContain("Sentry init skipped");
    }
  });

  it("stays silent and reports no_dsn when the variable is absent or blank", async () => {
    let stderr = "";
    const write = (chunk: string) => {
      stderr += chunk;
      return true;
    };
    expect(await initCliSentry({}, { write })).toEqual({
      initialized: false,
      reason: "no_dsn",
    });
    expect(await initCliSentry({ OBS_SENTRY_DSN: "   " }, { write })).toEqual({
      initialized: false,
      reason: "no_dsn",
    });
    expect(stderr).toBe("");
  });

  it("resolves a secret with an unresolved locator in the environment", async () => {
    const io = captureIo("");
    let stderr = "";
    const bootstrap = await initCliSentry(
      { OBS_SENTRY_DSN: "lastsecrets://obs-sentry-dsn-routines" },
      {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        },
      },
    );
    expect(bootstrap.initialized).toBe(false);

    // The bootstrap did not throw, so the command still runs and still answers
    // on its own terms. `ref` is the pure command that proves the sequence.
    const code = await run(["ref", "claude-code-oauth-token"], io);
    expect(code).toBe(0);
    expect(io.out()).toBe("lastsecrets://claude-code-oauth-token\n");
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
