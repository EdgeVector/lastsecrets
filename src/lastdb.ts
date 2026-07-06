import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { OWNER_APP_ID, type SchemaDefinition } from "./schema.ts";

export type QueryRow = {
  fields: Record<string, unknown>;
  key: { hash: string | null; range: string | null };
};

export type LastDbClient = {
  autoIdentity(): Promise<{ userHash: string }>;
  declareAppSchema(
    appId: string,
    schema: SchemaDefinition,
  ): Promise<{ canonical: string; schemaName: string }>;
  createRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
  }): Promise<void>;
  updateRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
  }): Promise<void>;
  queryByKey(opts: {
    schemaHash: string;
    keyHash: string;
    fields: string[];
  }): Promise<QueryRow | null>;
  queryAll(opts: { schemaHash: string; fields: string[] }): Promise<QueryRow[]>;
};

export class LastSecretsError extends Error {
  readonly code: string;
  override readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "LastSecretsError";
    this.code = code;
    this.cause = cause;
  }
}

type FetchInit = RequestInit & { unix?: string };
type FetchLike = (url: string, init?: FetchInit) => Promise<Response>;

const QUERY_PAGE_SIZE = 1000;
const SOCKET_FILE_NAME = "folddb.sock";
const DEFAULT_NODE_URL = "http://localhost:9001";

export function defaultNodeUrl(): string {
  return process.env.LASTSECRETS_NODE_URL ?? DEFAULT_NODE_URL;
}

export function resolveSocketPath(override?: string): string {
  if (override && override.length > 0) return override;
  for (const name of [
    "LASTSECRETS_SOCKET_PATH",
    "FOLDDB_SOCKET_PATH",
    "FOLDDB_SOCK",
    "FBRAIN_FOLDDB_SOCKET",
  ]) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  const lastdbHome = process.env.LASTDB_HOME ?? join(homedir(), ".lastdb");
  const folddbHome = process.env.FOLDDB_HOME ?? join(homedir(), ".folddb");
  const lastdbSocket = join(lastdbHome, "data", SOCKET_FILE_NAME);
  const folddbSocket = join(folddbHome, "data", SOCKET_FILE_NAME);
  if (existsSync(lastdbSocket)) return lastdbSocket;
  return folddbSocket;
}

export function newLastDbClient(opts: {
  nodeUrl?: string;
  userHash?: string;
  socketPath?: string;
  fetchImpl?: FetchLike;
} = {}): LastDbClient {
  const nodeUrl = stripTrailingSlash(opts.nodeUrl ?? defaultNodeUrl());
  const socketPath = resolveSocketPath(opts.socketPath);
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);

  const callJson = async (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown> => {
    const headers: Record<string, string> = {};
    if (opts.userHash) headers["X-User-Hash"] = opts.userHash;
    let requestBody: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }

    const socket = isLoopbackNodeUrl(nodeUrl) ? routeSocketPathFor(method, path, socketPath) : null;
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
        "service_unreachable",
        socket
          ? `LastDB is not reachable over its Unix socket ${socket}.`
          : `LastDB is not reachable at ${nodeUrl}.`,
        err,
      );
    }

    const text = await response.text();
    const parsed = parseBody(text);
    if (!response.ok) {
      throw new LastSecretsError(
        `node_http_${response.status}`,
        `LastDB ${method} ${path} returned HTTP ${response.status}${safeBodyMessage(parsed)}`,
      );
    }
    return parsed;
  };

  const mutate = async (
    mutationType: "create" | "update",
    schemaHash: string,
    fields: Record<string, unknown>,
    keyHash: string,
  ): Promise<void> => {
    await callJson("/api/mutation", "POST", {
      type: "mutation",
      schema: schemaHash,
      fields_and_values: fields,
      key_value: { hash: keyHash, range: null },
      mutation_type: mutationType,
    });
  };

  return {
    async autoIdentity() {
      const body = await callJson("/api/system/auto-identity", "GET");
      const userHash = objectString(body, "user_hash");
      if (!userHash) {
        throw new LastSecretsError(
          "auto_identity_bad_response",
          "LastDB auto-identity response did not include user_hash.",
        );
      }
      return { userHash };
    },
    async declareAppSchema(appId, schema) {
      let body: unknown;
      try {
        body = await callJson("/api/apps/declare-schema", "POST", {
          app_id: appId,
          schema,
        });
      } catch (err) {
        if (!(err instanceof LastSecretsError) || err.code !== "node_http_404") {
          throw err;
        }
        body = await callJson("/api/schemas/declare", "POST", {
          namespace: appId,
          schema,
        });
      }
      const canonical = declareCanonical(body);
      const schemaName = declareSchemaName(body, appId, schema.name);
      if (!canonical) {
        throw new LastSecretsError(
          "schema_declare_bad_response",
          `LastDB did not return a canonical hash for ${OWNER_APP_ID}/LastSecret.`,
        );
      }
      return { canonical, schemaName };
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      await mutate("create", schemaHash, fields, keyHash);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      await mutate("update", schemaHash, fields, keyHash);
    },
    async queryByKey({ schemaHash, keyHash, fields }) {
      const body = await callJson("/api/query", "POST", {
        schema_name: schemaHash,
        fields,
        filter: { HashKey: keyHash },
        limit: QUERY_PAGE_SIZE,
        offset: 0,
      });
      const rows = responseRows(body);
      return rows.find((row) => row.key.hash === keyHash) ?? null;
    },
    async queryAll({ schemaHash, fields }) {
      const body = await callJson("/api/query", "POST", {
        schema_name: schemaHash,
        fields,
        limit: QUERY_PAGE_SIZE,
        offset: 0,
      });
      return responseRows(body);
    },
  };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isLoopbackNodeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function isFullSurfaceSocket(socketPath: string): boolean {
  return basename(socketPath) === "folddb-full.sock";
}

function routeSocketPathFor(method: string, path: string, socketPath: string): string {
  if (isFullSurfaceSocket(socketPath)) return socketPath;
  if (
    (method === "POST" && (path === "/api/query" || path === "/api/mutation")) ||
    (method === "GET" && (path === "/api/schemas" || path === "/api/system/auto-identity"))
  ) {
    return socketPath;
  }
  const full = join(dirname(socketPath), "folddb-full.sock");
  return existsSync(full) ? full : socketPath;
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function safeBodyMessage(body: unknown): string {
  const message = objectString(body, "message") || objectString(body, "error");
  return message ? `: ${redactKnownSecretWords(message)}` : "";
}

function objectString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : "";
}

function declareCanonical(body: unknown): string {
  const direct = objectString(body, "canonical") || objectString(body, "identity_hash");
  if (direct) return direct;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "";
  const data = (body as Record<string, unknown>).data;
  return objectString(data, "canonical") || objectString(data, "identity_hash");
}

function declareSchemaName(body: unknown, appId: string, localName: string): string {
  const direct = objectString(body, "schema") || objectString(body, "schema_name");
  if (direct) return direct.includes("/") ? direct : `${appId}/${direct}`;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const data = (body as Record<string, unknown>).data;
    const nested = objectString(data, "schema") || objectString(data, "schema_name");
    if (nested) return nested.includes("/") ? nested : `${appId}/${nested}`;
  }
  return `${appId}/${localName}`;
}

function responseRows(body: unknown): QueryRow[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const results = (body as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];
  return results.filter((row): row is QueryRow => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
    const r = row as Record<string, unknown>;
    return typeof r.fields === "object" && r.fields !== null && typeof r.key === "object";
  });
}

export function redactKnownSecretWords(value: string): string {
  return value.replace(/(secret_value|value|token|password|credential)=\S+/gi, "$1=<redacted>");
}
