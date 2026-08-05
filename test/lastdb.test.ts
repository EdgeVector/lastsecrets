import { describe, expect, it } from "bun:test";

import { newLastDbClient } from "../src/lastdb.ts";
import { lastSecretSchema } from "../src/schema.ts";

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
