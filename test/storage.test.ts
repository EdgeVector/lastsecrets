import { describe, expect, it } from "bun:test";

import { formatMetadata, getSecret, listSecrets, putSecret, searchSecrets } from "../src/storage.ts";
import type { LastDbClient, QueryRow } from "../src/lastdb.ts";

const CONFIG = { schemaHash: "schema-hash" };
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

function newMemoryClient(opts: { failWriteWith?: string } = {}): LastDbClient {
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
      return Array.from(rows.values());
    },
  };
}
