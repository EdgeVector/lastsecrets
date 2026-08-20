import { describe, expect, it } from "bun:test";

import { newBrainClient } from "../src/brain.ts";
import type { JsonValue, Transport } from "@lastdb/app-sdk";

type Request = {
  method: "GET" | "POST";
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};

describe("Brain migration client", () => {
  it("lists live keys, pages, and point-gets records without a scan header", async () => {
    const live = new Map([
      ["one", { body: "clean one" }],
      ["two", { body: "clean two" }],
      ["three", { body: "clean three" }],
    ]);
    const requests: Request[] = [];
    const transport: Transport = {
      target: "mock://lastdb",
      async send(method, path, options = {}) {
        const body = options.body as Record<string, unknown> | undefined;
        requests.push({ method, path, headers: options.headers ?? {}, body: body ?? null });
        if (method === "GET" && path.startsWith("/api/list?")) {
          const cursor = new URL(`http://localhost${path}`).searchParams.get("cursor");
          const hashes = Array.from(live.keys());
          const page = cursor ? hashes.slice(2) : hashes.slice(0, 2);
          return {
            status: 200,
            body: {
              list: {
                keys: page.map((hash) => ({ hash, range: null })),
                has_more: !cursor && hashes.length > 2,
                next_cursor: !cursor && hashes.length > 2 ? "page-2" : null,
              },
            },
          };
        }
        if (method === "POST" && path === "/api/query") {
          const filter = body?.filter as { HashKey?: string } | undefined;
          const hash = filter?.HashKey ?? "";
          const fields = live.get(hash);
          return {
            status: 200,
            body: {
              results: fields ? [{ key: { hash, range: null }, fields }] : [],
            },
          };
        }
        return { status: 404, body: { error: "unexpected route" } };
      },
    };
    const client = newBrainClient({ userHash: "user", transport });

    const readAll = async () => {
      const rows = [];
      for (const key of await client.listKeys("brain/Note")) {
        const row = await client.queryByKey("brain/Note", key, ["body"]);
        if (row) rows.push(row);
      }
      return rows;
    };

    expect((await readAll()).map((row) => row.key)).toEqual(["one", "two", "three"]);
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(2);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(3);
    for (const request of requests.filter((entry) => entry.method === "POST")) {
      expect(request.path).toBe("/api/query");
      expect(request.body?.filter).toHaveProperty("HashKey");
      expect(request.headers["X-LastDB-Allow-Full-Scan"]).toBeUndefined();
    }

    live.delete("two");
    requests.length = 0;
    expect((await readAll()).map((row) => row.key)).toEqual(["one", "three"]);
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(2);
  });

  it("uses an exact HashRangeKey for ranged records", async () => {
    let observedFilter: JsonValue | undefined;
    const transport: Transport = {
      target: "mock://lastdb",
      async send(method, path, options = {}) {
        if (method === "POST" && path === "/api/query") {
          observedFilter = (options.body as { filter?: JsonValue }).filter;
          return {
            status: 200,
            body: { results: [{ key: { hash: "board", range: "todo#1" }, fields: { body: "x" } }] },
          };
        }
        return { status: 404, body: {} };
      },
    };
    const client = newBrainClient({ userHash: "user", transport });

    const row = await client.queryByKey(
      "brain/Ranged",
      { hash: "board", range: "todo#1" },
      ["body"],
    );

    expect(row?.key).toBe("board");
    expect(row?.range).toBe("todo#1");
    expect(observedFilter).toEqual({ HashRangeKey: { hash: "board", range: "todo#1" } });
  });
});
