import { describe, expect, it } from "bun:test";

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
