import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isUnknownSchemaError, run } from "../src/cli.ts";
import { LastSecretsError, type LastDbClient, type QueryRow } from "../src/lastdb.ts";

// Fixture-based: a fake client counts calls. Nothing here touches a live node.
const NAMED = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1",
  userHash: "user",
  schemaHash: "h1",
  schemaName: "lastsecrets/LastSecret",
  indexSchemaHash: "h2",
  indexSchemaName: "lastsecrets/LastSecretIndex",
};

let dir: string;
let cfg: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lastsecrets-declare-"));
  cfg = join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function io() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (c: string) => ((out += c), true) },
    stderr: { write: (c: string) => ((err += c), true) },
    stdinText: async () => "",
    out: () => out,
    err: () => err,
  };
}

function fakeClient(opts: { failQueriesUntilDeclared?: boolean } = {}) {
  const calls = { declare: 0, query: 0, schemasQueried: [] as string[] };
  let declared = false;
  const client = {
    async autoIdentity() {
      return { userHash: "user" };
    },
    async declareAppSchema(_app: string, schema: { name: string }) {
      calls.declare++;
      declared = true;
      return { canonical: `hash-${schema.name}`, schemaName: `declared/${schema.name}` };
    },
    async queryByKey(q: { schemaHash: string }): Promise<QueryRow | null> {
      calls.query++;
      calls.schemasQueried.push(q.schemaHash);
      if (opts.failQueriesUntilDeclared && !declared) {
        throw new LastSecretsError("node_http_404", "LastDB data path returned HTTP 404: schema not found");
      }
      return { key: {}, fields: { slug: "a", secret_value: { value: "v" } } } as unknown as QueryRow;
    },
    async queryAll() {
      return [];
    },
  } as unknown as LastDbClient;
  return { client, calls };
}

describe("schema declare is not repeated on every command", () => {
  it("does not declare when config already has both schema names", async () => {
    writeFileSync(cfg, JSON.stringify(NAMED));
    const { client, calls } = fakeClient();
    const i = io();
    const code = await run(["get", "a", "--config", cfg], i, { newClient: () => client });
    expect(code).toBe(0);
    expect(calls.declare).toBe(0);
    expect(calls.schemasQueried).toEqual(["lastsecrets/LastSecret"]);
    expect(i.out()).toBe("v\n");
  });

  it("declares once and retries once on an unknown-schema error", async () => {
    writeFileSync(cfg, JSON.stringify(NAMED));
    const { client, calls } = fakeClient({ failQueriesUntilDeclared: true });
    const i = io();
    const code = await run(["get", "a", "--config", cfg], i, { newClient: () => client });
    expect(code).toBe(0);
    expect(calls.declare).toBe(2); // secret schema + index schema, once
    expect(calls.query).toBe(2); // first try + one retry
    expect(calls.schemasQueried[1]).toBe("declared/LastSecret");
  });

  it("does not retry or declare on an unrelated error", async () => {
    writeFileSync(cfg, JSON.stringify(NAMED));
    const { client, calls } = fakeClient();
    (client as unknown as { queryByKey: () => Promise<never> }).queryByKey = async () => {
      calls.query++;
      throw new LastSecretsError("service_unreachable", "LastDB is not reachable");
    };
    const code = await run(["get", "a", "--config", cfg], io(), { newClient: () => client });
    expect(code).toBe(1);
    expect(calls.declare).toBe(0);
    expect(calls.query).toBe(1);
  });

  it("declares in memory for a legacy config without names", async () => {
    const { schemaName: _a, indexSchemaName: _b, ...legacy } = NAMED;
    writeFileSync(cfg, JSON.stringify(legacy));
    const { client, calls } = fakeClient();
    const code = await run(["get", "a", "--config", cfg], io(), { newClient: () => client });
    expect(code).toBe(0);
    expect(calls.declare).toBe(2);
  });

  it("init still declares both schemas and writes the names", async () => {
    const { client, calls } = fakeClient();
    const i = io();
    const code = await run(["init", "--config", cfg], i, { newClient: () => client });
    expect(code).toBe(0);
    expect(calls.declare).toBe(2);
    const written = JSON.parse(readFileSync(cfg, "utf8"));
    expect(written.schemaName).toBe("declared/LastSecret");
    expect(written.indexSchemaName).toBe("declared/LastSecretIndex");
  });

  it("classifies unknown-schema errors narrowly", () => {
    expect(isUnknownSchemaError(new LastSecretsError("node_http_404", "schema not found: x"))).toBe(true);
    expect(isUnknownSchemaError(new LastSecretsError("service_unreachable", "schema not found"))).toBe(false);
    expect(isUnknownSchemaError(new Error("secret not found: a"))).toBe(false);
  });
});
