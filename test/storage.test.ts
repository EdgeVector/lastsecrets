import { describe, expect, it } from "bun:test";

import {
  buildAdminSecretsSlice,
  formatMetadata,
  getSecret,
  listSecrets,
  putSecret,
  searchSecrets,
} from "../src/storage.ts";
import type { LastDbClient, QueryRow } from "../src/lastdb.ts";

const CONFIG = { schemaHash: "schema-hash", indexSchemaHash: "index-schema-hash" };
const RAW_SECRET = "sk-live-do-not-print";

describe("LastSecrets storage", () => {
  it("stores and retrieves through a LastDB client without exposing values in metadata", async () => {
    const client = newMemoryClient();
    const meta = await putSecret(client, CONFIG, {
      slug: "cloudflare-r2-dev",
      label: "Cloudflare R2 dev token",
      provider: "cloudflare",
      purpose: "schema resolver upload",
      environment: "dev",
      value: RAW_SECRET,
    });

    expect(formatMetadata(meta)).toContain("value=<redacted>");
    expect(formatMetadata(meta)).not.toContain(RAW_SECRET);

    const fetched = await getSecret(client, CONFIG, "cloudflare-r2-dev");
    expect(fetched.secretValue).toBe(RAW_SECRET);
  });

  // A stored empty value must not read as a successful fetch. Callers act on the
  // exit code and on stdout; an empty value with a success answer is
  // indistinguishable from a real secret that happens to be empty, and every
  // caller then proceeds with nothing.
  it("refuses a stored empty value instead of answering with success", async () => {
    const client = newMemoryClient();
    await client.createRecord({
      schemaHash: CONFIG.schemaHash,
      keyHash: "blank-token",
      fields: {
        slug: "blank-token",
        label: "Blank token",
        provider: "example",
        purpose: "regression",
        environment: "dev",
        secret_value: { value: "" },
        created_at: "2026-09-07T00:00:00.000Z",
        updated_at: "2026-09-07T00:00:00.000Z",
      },
    });

    await expect(getSecret(client, CONFIG, "blank-token")).rejects.toThrow(
      "secret has no value: blank-token",
    );
  });

  it("lists and searches only metadata fields", async () => {
    const client = newMemoryClient();
    await putSecret(client, CONFIG, {
      slug: "prod-api",
      label: "Production API token",
      provider: "example",
      purpose: "deploy",
      environment: "prod",
      value: RAW_SECRET,
    });

    const listed = await listSecrets(client, CONFIG);
    const searchedBySecret = await searchSecrets(client, CONFIG, RAW_SECRET);
    const searchedByMetadata = await searchSecrets(client, CONFIG, "production");

    expect(formatMetadata(listed[0]!)).not.toContain(RAW_SECRET);
    expect(searchedBySecret).toEqual([]);
    expect(searchedByMetadata).toHaveLength(1);
  });

  it("builds an admin slice with metadata only", async () => {
    const client = newMemoryClient();
    await putSecret(client, CONFIG, {
      slug: "prod-api",
      label: "Production API token",
      provider: "example",
      purpose: "deploy",
      environment: "prod",
      value: RAW_SECRET,
    });

    const slice = buildAdminSecretsSlice(
      await listSecrets(client, CONFIG),
      "2026-07-15T09:00:00.000Z",
    );
    const encoded = JSON.stringify(slice);

    expect(slice).toEqual({
      app_id: "lastsecrets",
      schema: "lastsecrets.admin.slice.v1",
      captured_at: "2026-07-15T09:00:00.000Z",
      total: 1,
      secrets: [
        {
          slug: "prod-api",
          label: "Production API token",
          provider: "example",
          purpose: "deploy",
          env: "prod",
          updated_at: expect.any(String),
        },
      ],
    });
    expect(encoded).not.toContain(RAW_SECRET);
    expect(encoded).not.toContain("secretValue");
    expect(encoded).not.toContain("secret_value");
    expect(encoded).not.toContain("lastsecrets://");
  });

  it("never issues a full-schema scan to list, search, or put a secret", async () => {
    const calls = { queryAll: 0 };
    const client = newMemoryClient({ calls });
    await putSecret(client, CONFIG, {
      slug: "prod-api",
      label: "Production API token",
      provider: "example",
      purpose: "deploy",
      environment: "prod",
      value: RAW_SECRET,
    });
    await putSecret(client, CONFIG, {
      slug: "staging-api",
      label: "Staging API token",
      provider: "example",
      purpose: "deploy",
      environment: "staging",
      value: RAW_SECRET,
    });

    const listed = await listSecrets(client, CONFIG);
    const searched = await searchSecrets(client, CONFIG, "staging");

    expect(listed.map((s) => s.slug)).toEqual(["prod-api", "staging-api"]);
    expect(searched.map((s) => s.slug)).toEqual(["staging-api"]);
    expect(calls.queryAll).toBe(0);
  });

  it("redacts the secret if a write error echoes it", async () => {
    const client = newMemoryClient({
      failWriteWith: `node rejected value=${RAW_SECRET}`,
    });

    await expect(
      putSecret(client, CONFIG, {
        slug: "bad-write",
        label: "Bad write",
        provider: "example",
        purpose: "test",
        environment: "dev",
        value: RAW_SECRET,
      }),
    ).rejects.toThrow("value=<redacted>");
  });
});

function newMemoryClient(
  opts: { failWriteWith?: string; calls?: { queryAll: number } } = {},
): LastDbClient {
  const rows = new Map<string, QueryRow>();
  const write = async (keyHash: string, fields: Record<string, unknown>) => {
    if (opts.failWriteWith) throw new Error(opts.failWriteWith);
    rows.set(keyHash, { key: { hash: keyHash, range: null }, fields });
  };

  return {
    async autoIdentity() {
      return { userHash: "user" };
    },
    async declareAppSchema() {
      return { canonical: CONFIG.schemaHash, schemaName: "lastsecrets/LastSecret" };
    },
    async registerForDistribution() {
      return {
        app_id: "lastsecrets",
        ok: true,
        items: [
          {
            app_id: "lastsecrets",
            schema_name: "lastsecrets/LastSecret",
            identity_hash: CONFIG.schemaHash,
            status: "registered" as const,
          },
        ],
      };
    },
    async verifyDistributionReady() {
      return {
        app_id: "lastsecrets",
        ready: true,
        items: [{ identity: CONFIG.schemaHash, status: "present" as const }],
      };
    },
    async createRecord({ keyHash, fields }) {
      await write(keyHash, fields);
    },
    async updateRecord({ keyHash, fields }) {
      await write(keyHash, fields);
    },
    async queryByKey({ keyHash }) {
      return rows.get(keyHash) ?? null;
    },
    async queryAll() {
      if (opts.calls) opts.calls.queryAll++;
      return Array.from(rows.values());
    },
  };
}
