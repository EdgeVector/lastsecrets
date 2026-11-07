import { homedir } from "node:os";
import { join } from "node:path";

import {
  TransportError,
  UnexpectedResponseError,
  httpTransport,
  udsTransport,
  type Transport as SdkTransport,
} from "@lastdb/app-sdk";

import { OWNER_APP_ID, type SchemaDefinition } from "./schema.ts";
import { canonicalSchema, profilesFor } from "./canonical-vocabulary.ts";
import { ownedDeclaration, requireOwnedHome } from "./schema-mode.ts";
import { fieldAliasTransport, type FieldAliasProfiles } from "./field-alias-transport.ts";
import { newNativeBatchClient, type NativeBatchClient } from "./batch.ts";

export type QueryRow = {
  fields: Record<string, unknown>;
  key: { hash: string | null; range: string | null };
  revision: string;
};

export type LastDbClient = {
  readonly schemaFieldAliases?: FieldAliasProfiles;
  nativeBatch: NativeBatchClient;
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
    revision: string;
  }): Promise<void>;
  queryByKey(opts: {
    schemaHash: string;
    keyHash: string;
    fields: string[];
  }): Promise<QueryRow | null>;
  /**
   * Exact HashKey reads of one schema through `/api/queries/batch`, in key
   * order (null for an absent key). Any item the node does not confirm fails
   * the whole call: an unread row must never look like an absent row.
   */
  queryByKeys(opts: {
    schemaHash: string;
    keys: readonly string[];
    fields: string[];
  }): Promise<(QueryRow | null)[]>;
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

/** The native `/api/queries/batch` limit. */
const BATCH_READ_LIMIT = 64;
const SOCKET_FILE_NAME = "folddb.sock";
// Local Mini is Unix-socket only. DEFAULT_NODE_URL is a loopback *marker*
// (hostname only) so clients select socket transport via isLoopbackNodeUrl —
// it is NOT a TCP endpoint. Retired control plane :9001 must never be the default.
const DEFAULT_NODE_URL = "http://127.0.0.1";
const STALE_NODE_URLS: ReadonlySet<string> = new Set([
  "http://127.0.0.1:9001",
  "http://localhost:9001",
]);

export function defaultNodeUrl(): string {
  return process.env.LASTSECRETS_NODE_URL ?? DEFAULT_NODE_URL;
}

/** Heal retired TCP :9001 URLs to the socket-only loopback marker. */
export function normalizeNodeUrl(url: string | undefined | null): string {
  const raw = (url ?? "").trim().replace(/\/$/, "");
  if (!raw || STALE_NODE_URLS.has(raw)) return DEFAULT_NODE_URL;
  return raw;
}

export function resolveSocketPath(override?: string, configValue?: string): string {
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
  if (configValue && configValue.length > 0) return configValue;
  const lastdbHome = process.env.LASTDB_HOME ?? join(homedir(), ".lastdb");
  return join(lastdbHome, "data", SOCKET_FILE_NAME);
}

export function newLastDbClient(opts: {
  nodeUrl?: string;
  userHash?: string;
  socketPath?: string;
  socketPathOverride?: string;
  fetchImpl?: FetchLike;
  queryTimeoutMs?: number;
  schemaFieldAliases?: FieldAliasProfiles;
  canonicalVocabulary?: boolean | "auto";
} = {}): LastDbClient {
  const nodeUrl = stripTrailingSlash(opts.nodeUrl ?? defaultNodeUrl());
  const socketPath = resolveSocketPath(opts.socketPathOverride, opts.socketPath);
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const queryTimeoutMs = opts.queryTimeoutMs ?? 30_000; // 30s default timeout
  const defaultHeaders: Record<string, string> = {
    "X-LastDB-Client": "lastsecrets",
    ...(opts.userHash ? { "X-User-Hash": opts.userHash } : {}),
  };
  const fieldProfiles: FieldAliasProfiles = {...opts.schemaFieldAliases};
  const sdkTransport: SdkTransport = fieldAliasTransport(isLoopbackNodeUrl(nodeUrl)
    ? udsTransport(socketPath, defaultHeaders)
    : httpTransport(nodeUrl, defaultHeaders), fieldProfiles);
  // API 30 returns complete records. Project only inside this owner process.
  const readKeyBatch = async (
    schemaHash: string,
    keys: string[],
    fields: string[],
  ): Promise<(QueryRow | null)[]> => {
    const body = {
      queries: keys.map((key) => ({
        schema_name: schemaHash, filter: { HashKey: key }, limit: 2, offset: 0,
      })),
    };
    let response;
    try {
      response = await withTimeout(sdkTransport.send("POST", "/api/queries/batch", { body }), queryTimeoutMs);
    } catch (err) {
      if (err instanceof LastSecretsError) throw err;
      throw mapSdkError(err, nodeUrl, socketPath);
    }
    if (response.status !== 200) {
      throw new LastSecretsError(
        `node_http_${response.status}`,
        `LastDB POST /api/queries/batch returned HTTP ${response.status}${safeBodyMessage(response.body)}`,
      );
    }
    const reply = asObject(response.body);
    if (!reply || !Array.isArray(reply.results) || reply.results.length !== keys.length) {
      throw new LastSecretsError("batch_read_ambiguous", "LastDB returned an incomplete batch read.");
    }
    return reply.results.map((item, position) => {
      const key = keys[position]!;
      const envelope = asObject(item);
      const page = asObject(envelope?.response);
      // A Hash key names at most one record.
      if (envelope?.status !== 200 || !page || page.ok === false || !Array.isArray(page.results) ||
          page.results.length > 1 || page.has_more === true) {
        throw new LastSecretsError("batch_read_ambiguous", `LastDB did not confirm the read of key ${key}.`);
      }
      if (page.results.length === 0) return null;
      const row = asObject(page.results[0]);
      const rowKey = asObject(row?.key);
      const rowFields = asObject(row?.fields);
      const revision = row?.revision;
      if (!rowFields || rowKey?.hash !== key || rowKey.range !== null ||
          typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
        throw new LastSecretsError("batch_read_ambiguous", `LastDB returned another record for key ${key}.`);
      }
      return {
        fields: Object.fromEntries(fields.filter((field) => Object.hasOwn(rowFields, field)).map((field) => [field, rowFields[field]])),
        key: { hash: key, range: null },
        revision,
      };
    });
  };

  const writeRecord = async (schema: string, hash: string, fields: Record<string, unknown>, revision?: string) => {
    let response;
    try {
      response = await withTimeout(sdkTransport.send("POST", "/api/mutation", { body: {
        type: "mutation", schema, record: fields, key_value: { hash, range: null }, alternates: {},
        mutation_type: revision === undefined ? "create" : "replace",
        expected: revision === undefined ? { type: "absent" } : { type: "revision", revision },
        durability: "durable",
      } }), queryTimeoutMs);
    } catch (err) {
      throw mapSdkError(err, nodeUrl, socketPath);
    }
    const written = asObject(response.body)?.record_revision;
    if (response.status !== 200 || typeof written !== "string" || !/^[a-f0-9]{64}$/.test(written)) {
      throw new LastSecretsError("record_write_unconfirmed", `LastDB did not confirm the record write (HTTP ${response.status}).`);
    }
  };

  // Owner setup still uses node-specific endpoints that the app data SDK does
  // not expose: auto-identity and schema declaration.
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

    const socket = isLoopbackNodeUrl(nodeUrl) ? socketPath : null;
    const url = socket ? `http://localhost${path}` : `${nodeUrl}${path}`;
    let response: Response;
    try {
      const fetchPromise = fetchImpl(url, {
        method,
        headers,
        body: requestBody,
        ...(socket ? { unix: socket } : {}),
      });
      response = await withTimeout(fetchPromise, queryTimeoutMs);
    } catch (err) {
      if (err instanceof LastSecretsError && err.code === "query_timeout") {
        throw err;
      }
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

  // A field map selects field names. It never selects the record-ownership model.
  let canonicalMode: boolean | undefined = opts.canonicalVocabulary === "auto"
    ? undefined : opts.canonicalVocabulary ?? Boolean(opts.schemaFieldAliases);
  let vocabularyReadiness: Promise<boolean> | undefined;
  const useCanonicalVocabulary = (): Promise<boolean> => {
    return vocabularyReadiness ??= (async () => {
      const [catalog, version] = await Promise.all([
        callJson("/api/schemas", "GET").then(unwrapData), callJson("/api/version", "GET").then(unwrapData),
      ]);
      if (!Array.isArray(catalog.schemas)) throw new LastSecretsError("schema_catalog_invalid", "Cannot confirm the local schema format before declaration.");
      requireOwnedHome(catalog.schemas, version);
      const legacy = catalog.schemas.some((value) => {
        if (!value || typeof value !== "object") return false;
        const schema = value as Record<string, unknown>;
        return schema.owner_app_id === OWNER_APP_ID && Array.isArray(schema.fields) &&
          schema.fields.some((name) => name === "slug" || name === "payload_json" || name === "secret_value");
      });
      canonicalMode ??= !legacy;
      if (canonicalMode && legacy) throw new LastSecretsError("canonical_migration_required", "This home uses legacy secret fields. An explicit data migration is required before new schema publication.");
      return canonicalMode;
    })();
  };

  return {
    get schemaFieldAliases() { return canonicalMode === true ? {...fieldProfiles} : undefined; },
    nativeBatch: newNativeBatchClient(sdkTransport),
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
      const canonicalMode = await useCanonicalVocabulary();
      const local = schema;
      if (canonicalMode) schema = canonicalSchema(schema);
      const body = await callJson("/api/schemas/declare", "POST", {namespace:appId, schema});
      const {identity, runtime} = ownedDeclaration(body, `${appId}/${schema.name}`);
      if (canonicalMode) Object.assign(fieldProfiles, profilesFor(local, [identity, runtime]));
      return {canonical:identity, schemaName:runtime};
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      await writeRecord(schemaHash, keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash, revision }) {
      await writeRecord(schemaHash, keyHash, fields, revision);
    },
    async queryByKey({ schemaHash, keyHash, fields }) {
      return (await readKeyBatch(schemaHash, [keyHash], fields))[0] ?? null;
    },
    async queryByKeys({ schemaHash, keys, fields }) {
      const chunks: string[][] = [];
      for (let start = 0; start < keys.length; start += BATCH_READ_LIMIT) {
        chunks.push(keys.slice(start, start + BATCH_READ_LIMIT));
      }
      const replies = await Promise.all(chunks.map((chunk) => readKeyBatch(schemaHash, chunk, fields)));
      return replies.flat();
    },
  };
}

function mapSdkError(err: unknown, nodeUrl: string, socketPath: string): Error {
  if (err instanceof TransportError) {
    return new LastSecretsError(
      "service_unreachable",
      isLoopbackNodeUrl(nodeUrl)
        ? `LastDB is not reachable over its Unix socket ${socketPath}.`
        : `LastDB is not reachable at ${nodeUrl}.`,
      err,
    );
  }
  if (err instanceof UnexpectedResponseError) {
    return new LastSecretsError(
      `node_http_${err.status}`,
      `LastDB data path returned HTTP ${err.status}${safeBodyMessage(err.body)}`,
      err,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
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

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapData(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const rec = body as Record<string, unknown>;
  if (typeof rec.data === "object" && rec.data !== null && !Array.isArray(rec.data)) {
    return rec.data as Record<string, unknown>;
  }
  return rec;
}

export function redactKnownSecretWords(value: string): string {
  return value.replace(/(secret_value|value|token|password|credential)=\S+/gi, "$1=<redacted>");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(
      () =>
        reject(
          new LastSecretsError(
            "query_timeout",
            `LastDB query did not complete within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timeoutId));
  });
}
