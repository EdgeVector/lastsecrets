// Minimal read/update client for Brain (F-Brain) records over the local LastDB
// socket, scoped to exactly what the migration needs: enumerate candidate
// records, read their scannable text, and stage a single-field replacement that
// swaps a raw secret for a `lastsecrets://` locator.
//
// This deliberately mirrors the transport in `lastdb.ts` but stays independent
// of the LastSecrets schema: Brain owns its own schema, and the migration must
// not assume a fixed field layout. Records are treated as opaque field bags; the
// migration scans string fields and rewrites them in place.

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { LastSecretsError, resolveSocketPath, defaultNodeUrl } from "./lastdb.ts";

export type BrainRecord = {
  /** Hash key of the record, used to address updates. */
  key: string;
  /** Optional range key (null for hash-only schemas). */
  range: string | null;
  /** Raw field bag as returned by the node. */
  fields: Record<string, unknown>;
};

export type BrainClient = {
  /** All records for a schema, addressed by schema name or hash. */
  queryAll(schema: string, fields: string[]): Promise<BrainRecord[]>;
  /** Replace the field bag for a single record (targeted update, not mass rewrite). */
  updateRecord(schema: string, key: string, range: string | null, fields: Record<string, unknown>): Promise<void>;
};

type FetchInit = RequestInit & { unix?: string };
type FetchLike = (url: string, init?: FetchInit) => Promise<Response>;

const QUERY_PAGE_SIZE = 1000;

export function newBrainClient(opts: {
  nodeUrl?: string;
  userHash: string;
  socketPath?: string;
  fetchImpl?: FetchLike;
}): BrainClient {
  const nodeUrl = (opts.nodeUrl ?? defaultNodeUrl()).replace(/\/+$/, "");
  const socketPath = resolveSocketPath(opts.socketPath);
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);

  const callJson = async (path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> => {
    const headers: Record<string, string> = { "X-User-Hash": opts.userHash };
    let requestBody: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }
    const socket = isLoopback(nodeUrl) ? routeSocket(method, path, socketPath) : null;
    const url = socket ? `http://localhost${path}` : `${nodeUrl}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: requestBody,
        ...(socket ? { unix: socket } : {}),
      });
    } catch (err) {
      throw new LastSecretsError(
        "brain_unreachable",
        socket ? `Brain node is not reachable over its Unix socket ${socket}.` : `Brain node is not reachable at ${nodeUrl}.`,
        err,
      );
    }
    const text = await response.text();
    const parsed = text.length === 0 ? null : safeJson(text);
    if (!response.ok) {
      throw new LastSecretsError(
        `brain_http_${response.status}`,
        `Brain ${method} ${path} returned HTTP ${response.status}`,
      );
    }
    return parsed;
  };

  return {
    async queryAll(schema, fields) {
      const body = await callJson("/api/query", "POST", {
        schema_name: schema,
        fields,
        limit: QUERY_PAGE_SIZE,
        offset: 0,
      });
      return responseRecords(body);
    },
    async updateRecord(schema, key, range, fields) {
      await callJson("/api/mutation", "POST", {
        type: "mutation",
        schema,
        fields_and_values: fields,
        key_value: { hash: key, range },
        mutation_type: "update",
      });
    },
  };
}

function isLoopback(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function routeSocket(method: string, path: string, socketPath: string): string {
  if (basename(socketPath) === "folddb-full.sock") return socketPath;
  if ((method === "POST" && (path === "/api/query" || path === "/api/mutation"))) {
    return socketPath;
  }
  const full = join(dirname(socketPath), "folddb-full.sock");
  return existsSync(full) ? full : socketPath;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function responseRecords(body: unknown): BrainRecord[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const results = (body as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];
  const records: BrainRecord[] = [];
  for (const row of results) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const fields = r.fields;
    const keyObj = r.key;
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) continue;
    let key = "";
    let range: string | null = null;
    if (typeof keyObj === "object" && keyObj !== null && !Array.isArray(keyObj)) {
      const k = keyObj as Record<string, unknown>;
      key = typeof k.hash === "string" ? k.hash : "";
      range = typeof k.range === "string" ? k.range : null;
    }
    records.push({ key, range, fields: fields as Record<string, unknown> });
  }
  return records;
}
