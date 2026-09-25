import { describe, expect, it } from "bun:test";

import { LastSecretsError, newLastDbClient } from "../src/lastdb.ts";
import { lastSecretSchema } from "../src/schema.ts";

describe("LastDB client query timeout", () => {
  it("times out admin operations like declareAppSchema when LastDB does not respond", async () => {
    let fetchCalled = false;
    const client = newLastDbClient({
      userHash: "user",
      socketPath: "/tmp/folddb.sock",
      queryTimeoutMs: 100, // 100ms timeout for testing
      fetchImpl: async () => {
        fetchCalled = true;
        // Simulate a hanging request
        return new Promise(() => {});
      },
    });

    const start = Date.now();
    try {
      await client.declareAppSchema("lastsecrets", lastSecretSchema.schema);
      throw new Error("Expected declareAppSchema to throw");
    } catch (err) {
      const elapsed = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("did not complete within");
      expect(fetchCalled).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(elapsed).toBeLessThan(500);
    }
  });

  it("does not timeout when operations complete within the timeout window", async () => {
    const client = newLastDbClient({
      userHash: "user",
      socketPath: "/tmp/folddb.sock",
      queryTimeoutMs: 500,
      fetchImpl: async () => {
        // Respond after 50ms
        await new Promise((resolve) => setTimeout(resolve, 50));
        return Response.json({
          data: {
            identity_hash: "schema-hash",
            schema_name: "lastsecrets/LastSecret",
          },
        });
      },
    });

    const start = Date.now();
    const result = await client.declareAppSchema("lastsecrets", lastSecretSchema.schema);
    const elapsed = Date.now() - start;

    expect(result.canonical).toBe("schema-hash");
    // Should succeed and complete in time
    expect(elapsed).toBeLessThan(500);
  });

  it("propagates timeout error through mapSdkError with correct code", async () => {
    const client = newLastDbClient({
      userHash: "user",
      socketPath: "/tmp/folddb.sock",
      queryTimeoutMs: 50,
      fetchImpl: async () => {
        // Simulate a hanging request that never resolves
        return new Promise(() => {});
      },
    });

    try {
      await client.declareAppSchema("lastsecrets", lastSecretSchema.schema);
      throw new Error("Expected timeout error to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LastSecretsError);
      if (err instanceof LastSecretsError) {
        expect(err.code).toBe("query_timeout");
        expect(err.message).toContain("did not complete within");
      }
    }
  });
});

describe("LastDB client schema declaration", () => {
  it("declares and loads LastSecrets through the direct schema route", async () => {
    const calls: Array<{ url: string; unix?: string; body: unknown }> = [];
    const client = newLastDbClient({
      userHash: "user",
      socketPath: "/tmp/folddb.sock",
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          unix: init?.unix,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({
          data: {
            identity_hash: "schema-hash",
            schema_name: "lastsecrets/LastSecret",
          },
        });
      },
    });

    const declared = await client.declareAppSchema("lastsecrets", lastSecretSchema.schema);

    expect(declared).toEqual({
      canonical: "schema-hash",
      schemaName: "lastsecrets/LastSecret",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost/api/schemas/declare");
    expect(calls[0]!.unix).toBe("/tmp/folddb.sock");
    expect(calls[0]!.body).toMatchObject({
      namespace: "lastsecrets",
      schema: { name: "LastSecret" },
    });
  });

  it("falls back to the app declaration route on older nodes", async () => {
    const paths: string[] = [];
    const client = newLastDbClient({
      userHash: "user",
      socketPath: "/tmp/folddb.sock",
      fetchImpl: async (url) => {
        paths.push(new URL(url).pathname);
        if (url.endsWith("/api/schemas/declare")) {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        return Response.json({
          canonical: "schema-hash",
          schema: "LastSecret",
        });
      },
    });

    const declared = await client.declareAppSchema("lastsecrets", lastSecretSchema.schema);

    expect(paths).toEqual(["/api/schemas/declare", "/api/apps/declare-schema"]);
    expect(declared).toEqual({
      canonical: "schema-hash",
      schemaName: "lastsecrets/LastSecret",
    });
  });

  it("registers and verifies schemas for distribution", async () => {
    const paths: string[] = [];
    const client = newLastDbClient({
      userHash: "user",
      socketPath: "/tmp/folddb.sock",
      fetchImpl: async (url, init) => {
        paths.push(new URL(url).pathname);
        const path = new URL(url).pathname;
        if (path === "/api/apps/register-for-distribution") {
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          expect(body).toMatchObject({
            app_id: "lastsecrets",
            schemas: [{ name: "LastSecret" }],
          });
          return Response.json({
            data: {
              app_id: "lastsecrets",
              ok: true,
              items: [
                {
                  app_id: "lastsecrets",
                  schema_name: "lastsecrets/LastSecret",
                  identity_hash: "deadbeef",
                  status: "registered",
                },
              ],
            },
          });
        }
        if (path === "/api/apps/verify-distribution-ready") {
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          expect(body).toMatchObject({
            app_id: "lastsecrets",
            schema_identities: ["deadbeef"],
          });
          return Response.json({
            data: {
              app_id: "lastsecrets",
              ready: true,
              items: [{ identity: "deadbeef", status: "present" }],
            },
          });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });

    const registered = await client.registerForDistribution("lastsecrets", [
      lastSecretSchema.schema,
    ]);
    expect(registered.ok).toBe(true);
    expect(registered.items[0]?.identity_hash).toBe("deadbeef");

    const verified = await client.verifyDistributionReady("lastsecrets", ["deadbeef"]);
    expect(verified.ready).toBe(true);
    expect(paths).toEqual([
      "/api/apps/register-for-distribution",
      "/api/apps/verify-distribution-ready",
    ]);
  });
});
