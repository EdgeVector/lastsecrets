// Minimal read/update client for Brain (F-Brain) records over the local LastDB
// socket, scoped to exactly what the migration needs: enumerate candidate
// records, read their scannable text, and stage a single-field replacement that
// swaps a raw secret for a `lastsecrets://` locator.
//
// Brain owns its own schemas, and the migration must not assume a fixed field
// layout. Records are treated as opaque field bags; the migration scans string
// fields and rewrites them in place.

import {
  LastDbClient as SdkLastDbClient,
  TransportError,
  UnexpectedResponseError,
  capabilityStoreKey,
  httpTransport,
  udsTransport,
  type CapabilityStore,
  type JsonValue,
  type QueryRow as SdkQueryRow,
  type Transport as SdkTransport,
} from "@lastdb/app-sdk";

import { LastSecretsError, resolveSocketPath, defaultNodeUrl, redactKnownSecretWords } from "./lastdb.ts";

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

const QUERY_PAGE_SIZE = 1000;
const FBRAIN_APP_ID = "fbrain";
const noopCapabilityStore: CapabilityStore = {
  async store() {},
  async load() {
    return null;
  },
  async remove() {},
};

export function newBrainClient(opts: {
  nodeUrl?: string;
  userHash: string;
  socketPath?: string;
}): BrainClient {
  const nodeUrl = stripTrailingSlash(opts.nodeUrl ?? defaultNodeUrl());
  const socketPath = resolveSocketPath(opts.socketPath);
  const defaultHeaders = { "X-User-Hash": opts.userHash, "X-LastDB-Client": "lastsecrets" };
  const sdkTransport: SdkTransport = isLoopbackNodeUrl(nodeUrl)
    ? udsTransport(socketPath, defaultHeaders)
    : httpTransport(nodeUrl, defaultHeaders);
  const sdkStoreKey = capabilityStoreKey(FBRAIN_APP_ID, sdkTransport.target);
  let sdkClient: SdkLastDbClient | null = null;
  const dataClient = (): SdkLastDbClient => {
    sdkClient ??= new SdkLastDbClient(
      FBRAIN_APP_ID,
      sdkTransport,
      noopCapabilityStore,
      null,
      sdkStoreKey,
      sdkTransport.target,
    );
    return sdkClient;
  };

  const sdkDataPath = async <T>(fn: (client: SdkLastDbClient) => Promise<T>): Promise<T> => {
    try {
      return await fn(dataClient());
    } catch (err) {
      throw mapSdkError(err, nodeUrl, socketPath);
    }
  };

  return {
    async queryAll(schema, fields) {
      const result = await sdkDataPath((client) =>
        client.queryAll(schema, { fields }, { pageSize: QUERY_PAGE_SIZE }),
      );
      return result.rows.map(sdkRowToBrainRecord);
    },
    async updateRecord(schema, key, range, fields) {
      await sdkDataPath((client) =>
        client.mutate(schema, {
          mutationType: "update",
          fields: fields as Record<string, JsonValue>,
          key: { hash: key, range },
        }),
      );
    },
  };
}

function sdkRowToBrainRecord(row: SdkQueryRow): BrainRecord {
  const keyValue = row.keyValue ?? renderedKeyToKeyValue(row.key);
  return {
    key: keyValue.hash ?? row.key,
    range: keyValue.range,
    fields: row.fields,
  };
}

function renderedKeyToKeyValue(key: string): { hash: string; range: string | null } {
  return { hash: key, range: null };
}

function mapSdkError(err: unknown, nodeUrl: string, socketPath: string): Error {
  if (err instanceof TransportError) {
    return new LastSecretsError(
      "brain_unreachable",
      isLoopbackNodeUrl(nodeUrl)
        ? `Brain node is not reachable over its Unix socket ${socketPath}.`
        : `Brain node is not reachable at ${nodeUrl}.`,
      err,
    );
  }
  if (err instanceof UnexpectedResponseError) {
    return new LastSecretsError(
      `brain_http_${err.status}`,
      `Brain data path returned HTTP ${err.status}${safeBodyMessage(err.body)}`,
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

function safeBodyMessage(body: unknown): string {
  const message = objectString(body, "message") || objectString(body, "error");
  return message ? `: ${redactKnownSecretWords(message)}` : "";
}

function objectString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : "";
}
