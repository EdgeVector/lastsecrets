import { homedir } from "node:os";
import { join } from "node:path";

import {
  AppApiError,
  LastDbClient as SdkClient,
  TransportError,
  UnexpectedResponseError,
  udsTransport,
  type AppApiMutation,
  type AppApiReadResult,
  type AppApiRecord,
  type RowFields,
  type Transport as SdkTransport,
} from "@lastdb/app-sdk";

import { profilesFor } from "./canonical-vocabulary.ts";
import { fieldAliasTransport, type FieldAliasProfiles } from "./field-alias-transport.ts";
import { newNativeBatchClient, type NativeBatchClient } from "./batch.ts";
import {
  LAST_SECRET_INDEX_SCHEMA,
  LAST_SECRET_SCHEMA,
  lastSecretIndexSchema,
  lastSecretSchema,
} from "./schema.ts";

export type QueryRow = {
  fields: Record<string, unknown>;
  key: { hash: string | null; range: string | null };
  revision: string;
};

export type LastDbClient = {
  readonly schemaFieldAliases: FieldAliasProfiles;
  nativeBatch: NativeBatchClient;
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
   * Exact key reads of one schema through `POST /v1/read`, in key order
   * (null for an absent key). A read the node does not confirm fails the
   * whole call: an unread row must never look like an absent row.
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

/** The app API accepts at most 64 reads in one list. */
const BATCH_READ_LIMIT = 64;
const SOCKET_FILE_NAME = "folddb.sock";
// Local Mini is Unix-socket only. DEFAULT_NODE_URL is the loopback marker stored in config.
const DEFAULT_NODE_URL = "http://127.0.0.1";

export function defaultNodeUrl(): string {
  return process.env.LASTSECRETS_NODE_URL ?? DEFAULT_NODE_URL;
}

export function resolveSocketPath(override?: string, configValue?: string): string {
  if (override && override.length > 0) return override;
  for (const name of [
    "LASTSECRETS_SOCKET_PATH",
    "LASTDB_SOCKET_PATH",
  ]) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  if (configValue && configValue.length > 0) return configValue;
  const lastdbHome = process.env.LASTDB_HOME ?? join(homedir(), ".lastdb");
  return join(lastdbHome, "data", SOCKET_FILE_NAME);
}

/** Local field names for the two installed schemas. The installer places the canonical names. */
export function installedFieldAliases(): FieldAliasProfiles {
  return {
    ...profilesFor(lastSecretSchema.schema, [LAST_SECRET_SCHEMA]),
    ...profilesFor(lastSecretIndexSchema.schema, [LAST_SECRET_INDEX_SCHEMA]),
  };
}

export function newLastDbClient(opts: {
  socketPath?: string;
  socketPathOverride?: string;
  queryTimeoutMs?: number;
  schemaFieldAliases?: FieldAliasProfiles;
} = {}): LastDbClient {
  const socketPath = resolveSocketPath(opts.socketPathOverride, opts.socketPath);
  const queryTimeoutMs = opts.queryTimeoutMs ?? 30_000;
  const fieldProfiles: FieldAliasProfiles = {
    ...installedFieldAliases(),
    ...opts.schemaFieldAliases,
  };
  const sdkTransport: SdkTransport = fieldAliasTransport(
    udsTransport(socketPath, { "X-LastDB-Client": "lastsecrets" }, { timeoutMs: queryTimeoutMs }),
    fieldProfiles,
  );
  // Construct the client directly. connect() calls GET /api/version, which the app socket does not serve.
  const sdk = new SdkClient("lastsecrets", sdkTransport);

  const readKeyBatch = async (
    schema: string,
    keys: string[],
    fields: string[],
  ): Promise<(QueryRow | null)[]> => {
    if (keys.length === 0) return [];
    let results: AppApiReadResult[];
    try {
      results = await withTimeout(sdk.read(keys.map((key) => ({
        schema,
        key: { hash: key, range: null },
        limit: 2,
      }))), queryTimeoutMs);
    } catch (err) {
      if (err instanceof LastSecretsError) throw err;
      throw mapSdkError(err, socketPath);
    }
    if (results.length !== keys.length) {
      throw new LastSecretsError("batch_read_ambiguous", "LastDB returned an incomplete batch read.");
    }
    return results.map((item, position) => pointRow(item, keys[position]!, fields));
  };

  const writeRecord = async (
    schema: string,
    hash: string,
    fields: Record<string, unknown>,
    revision?: string,
  ) => {
    const key = { hash, range: null };
    const record = fields as RowFields;
    const mutation: AppApiMutation = revision === undefined
      ? { op: "create", schema, key, record }
      : { op: "replace", schema, key, revision, record };
    let written;
    try {
      written = await withTimeout(sdk.write([mutation]), queryTimeoutMs);
    } catch (err) {
      throw mapSdkError(err, socketPath);
    }
    const next = written.revisions[0];
    if (written.written !== 1 || typeof next !== "string" || next.length === 0) {
      throw new LastSecretsError("record_write_unconfirmed", "LastDB did not confirm the record write.");
    }
  };

  return {
    get schemaFieldAliases() { return {...fieldProfiles}; },
    nativeBatch: newNativeBatchClient({
      read: (reads) => sdk.read(reads),
      write: (mutations) => sdk.write(mutations),
    }),
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

function pointRow(result: AppApiReadResult, key: string, fields: string[]): QueryRow | null {
  if ("error" in result) {
    // not_found here means the schema name is wrong. An absent key is an empty record list.
    throw new LastSecretsError(
      result.error.code || "record_read_failed",
      `LastDB did not confirm the read of key ${key}: ${redactKnownSecretWords(result.error.message)}`,
    );
  }
  if (!("records" in result) || result.next_cursor !== null || result.records.length > 1) {
    throw new LastSecretsError("batch_read_ambiguous", `LastDB did not confirm the read of key ${key}.`);
  }
  if (result.records.length === 0) return null;
  return rowFromRecord(result.records[0]!, key, fields);
}

function rowFromRecord(row: AppApiRecord, key: string, fields: string[]): QueryRow {
  if (row.key.hash !== key || row.key.range !== null || typeof row.revision !== "string" || row.revision.length === 0) {
    throw new LastSecretsError("batch_read_ambiguous", `LastDB returned another record for key ${key}.`);
  }
  const record = row.record as Record<string, unknown>;
  return {
    fields: Object.fromEntries(fields.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]])),
    key: { hash: key, range: null },
    revision: row.revision,
  };
}

function mapSdkError(err: unknown, socketPath: string): Error {
  if (err instanceof AppApiError) {
    return new LastSecretsError(
      err.status === 409 ? "conflict" : `node_http_${err.status}`,
      `LastDB returned HTTP ${err.status}${err.message ? `: ${redactKnownSecretWords(err.message)}` : ""}`,
      err,
    );
  }
  if (err instanceof TransportError) {
    return new LastSecretsError(
      "service_unreachable",
      `LastDB is not reachable over its Unix socket ${socketPath}.`,
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

function safeBodyMessage(body: unknown): string {
  const message = objectString(body, "message") || objectString(body, "error");
  return message ? `: ${redactKnownSecretWords(message)}` : "";
}

function objectString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : "";
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
