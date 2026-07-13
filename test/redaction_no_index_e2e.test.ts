import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { run } from "../src/cli.ts";
import type { QueryRow } from "../src/lastdb.ts";
import { searchableFields, type SchemaDefinition } from "../src/schema.ts";

const tempDirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

describe("LastSecrets redaction/no-index E2E", () => {
  afterEach(() => {
    while (servers.length > 0) {
      servers.pop()?.stop(true);
    }
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("keeps a generated raw value out of list/search/native-index outputs", async () => {
    const node = startMockLastDb();
    const dir = mkdtempSync(join(tmpdir(), "lastsecrets-redaction-e2e-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.json");
    const slug = `redaction-e2e-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const rawValue = `throwaway-${randomUUID()}-${randomUUID()}`;
    const metadataNeedle = `metadata-${slug}`;

    const initIo = captureIo("");
    expect(await run(["init", "--config", configPath, "--node-url", node.url], initIo)).toBe(0);

    const putIo = captureIo(rawValue);
    expect(
      await run(
        [
          "put",
          slug,
          "--config",
          configPath,
          "--label",
          metadataNeedle,
          "--provider",
          "local-e2e",
          "--purpose",
          "redaction proof",
          "--env",
          "test",
          "--value-stdin",
        ],
        putIo,
      ),
    ).toBe(0);

    const getIo = captureIo("");
    expect(await run(["get", slug, "--config", configPath], getIo)).toBe(0);
    if (getIo.out().trimEnd() !== rawValue) {
      throw new Error("get did not return the generated throwaway value");
    }
    assertAbsent(getIo.err(), "get stderr", rawValue);

    const listIo = captureIo("");
    expect(await run(["list", "--config", configPath], listIo)).toBe(0);
    expect(listIo.out()).toContain(slug);
    expect(listIo.out()).toContain(`lastsecrets://${slug}`);
    expect(listIo.out()).toContain(`label=${metadataNeedle}`);
    expect(listIo.out()).toContain("provider=local-e2e");
    expect(listIo.out()).toContain("purpose=redaction proof");
    expect(listIo.out()).toContain("env=test");
    expect(listIo.out()).toContain("value=<redacted>");

    const metadataSearchIo = captureIo("");
    expect(await run(["search", metadataNeedle, "--config", configPath], metadataSearchIo)).toBe(0);
    expect(metadataSearchIo.out()).toContain(slug);

    const rawSearchIo = captureIo("");
    expect(await run(["search", rawValue, "--config", configPath], rawSearchIo)).toBe(0);
    expect(rawSearchIo.out()).toBe("");

    const nativeMetadata = node.nativeIndexSearch(metadataNeedle);
    expect(nativeMetadata).toContain(slug);
    const nativeRaw = node.nativeIndexSearch(rawValue);
    expect(nativeRaw).toBe("");

    const redactedSurfaceTranscript = [
      initIo.out(),
      initIo.err(),
      putIo.out(),
      putIo.err(),
      listIo.out(),
      listIo.err(),
      metadataSearchIo.out(),
      metadataSearchIo.err(),
      rawSearchIo.out(),
      rawSearchIo.err(),
      nativeMetadata,
      nativeRaw,
    ].join("\n");
    assertAbsent(redactedSurfaceTranscript, "redacted CLI/index transcript", rawValue);
  });
});

function startMockLastDb() {
  const rows = new Map<string, QueryRow>();
  let searchable: string[] = [];
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/system/auto-identity") {
        return json({ user_hash: "test-user" });
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/api/apps/declare-schema" || url.pathname === "/api/schemas/declare")
      ) {
        const body = (await request.json()) as { schema?: SchemaDefinition };
        const schema = body.schema;
        searchable = schema ? searchableFields(schema) : [];
        return json({ canonical: "test-schema-hash", schema_name: "lastsecrets/LastSecret" });
      }
      if (request.method === "POST" && url.pathname === "/api/mutation") {
        const body = (await request.json()) as {
          key_value?: { hash?: string };
          fields_and_values?: Record<string, unknown>;
        };
        const key = body.key_value?.hash;
        if (!key || !body.fields_and_values) {
          return json({ message: "missing key or fields" }, 400);
        }
        rows.set(key, {
          key: { hash: key, range: null },
          fields: body.fields_and_values,
        });
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/query") {
        const body = (await request.json()) as { filter?: { HashKey?: string }; fields?: string[] };
        const selected = body.fields ?? [];
        const allRows = body.filter?.HashKey
          ? [rows.get(body.filter.HashKey)].filter((row): row is QueryRow => row !== undefined)
          : Array.from(rows.values());
        return json({ results: allRows.map((row) => selectFields(row, selected)) });
      }
      return json({ message: "not found" }, 404);
    },
  });
  servers.push(server);
  return {
    url: `http://0.0.0.0:${server.port}`,
    nativeIndexSearch(term: string): string {
      const needle = term.toLowerCase();
      return Array.from(rows.values())
        .filter((row) =>
          searchable.some((field) => String(row.fields[field] ?? "").toLowerCase().includes(needle)),
        )
        .map((row) => row.key.hash ?? "")
        .filter((key) => key.length > 0)
        .join("\n");
    },
  };
}

function selectFields(row: QueryRow, fields: string[]): QueryRow {
  const selected: Record<string, unknown> = {};
  for (const field of fields) selected[field] = row.fields[field];
  return { key: row.key, fields: selected };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

function assertAbsent(haystack: string, label: string, rawValue: string): void {
  if (haystack.includes(rawValue)) {
    throw new Error(`${label} exposed generated raw value`);
  }
}
