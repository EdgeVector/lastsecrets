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

export type BrainKey = {
  hash: string;
  range: string | null;
};

export type BrainClient = {
  /** Page through the live keys for a schema without loading atom bodies. */
  listKeys(schema: string): Promise<BrainKey[]>;
  /** Read one live record by its exact key. */
  queryByKey(schema: string, key: BrainKey, fields: string[]): Promise<BrainRecord | null>;
  /** Replace the field bag for a single record (targeted update, not mass rewrite). */
  updateRecord(schema: string, key: string, range: string | null, fields: Record<string, unknown>): Promise<void>;
};

const LIST_PAGE_SIZE = 1000;
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
  transport?: SdkTransport;
}): BrainClient {
  const nodeUrl = stripTrailingSlash(opts.nodeUrl ?? defaultNodeUrl());
  const socketPath = resolveSocketPath(opts.socketPath);
  const defaultHeaders = { "X-User-Hash": opts.userHash, "X-LastDB-Client": "lastsecrets" };
  const sdkTransport: SdkTransport = opts.transport ?? (isLoopbackNodeUrl(nodeUrl)
    ? udsTransport(socketPath, defaultHeaders)
    : httpTransport(nodeUrl, defaultHeaders));
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

  const transportDataPath = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw mapSdkError(err, nodeUrl, socketPath);
    }
  };

  return {
    async listKeys(schema) {
      return transportDataPath(async () => {
        const keys: BrainKey[] = [];
        let cursor: string | null = null;
        do {
          const params = new URLSearchParams({ schema, limit: String(LIST_PAGE_SIZE) });
          if (cursor) params.set("cursor", cursor);
          const response = await sdkTransport.send("GET", `/api/list?${params.toString()}`);
          if (response.status !== 200) {
            throw new UnexpectedResponseError(
              `brain list returned ${response.status}`,
              response.status,
              response.body,
            );
          }
          const page = parseListPage(response.body);
          keys.push(...page.keys);
          if (!page.hasMore) break;
          if (!page.nextCursor || page.nextCursor === cursor) {
            throw new Error("brain list pagination stalled: missing or repeated next_cursor");
          }
          cursor = page.nextCursor;
        } while (true);
        return keys;
      });
    },
    async queryByKey(schema, key, fields) {
      const filter: JsonValue = key.range === null
        ? { HashKey: key.hash }
        : { HashRangeKey: { hash: key.hash, range: key.range } };
      const result = await sdkDataPath((client) => client.query(schema, { fields, filter }));
      const row = result.rows[0];
      return row ? sdkRowToBrainRecord(row) : null;
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

function parseListPage(body: unknown): {
  keys: BrainKey[];
  hasMore: boolean;
  nextCursor: string | null;
} {
  const root = asRecord(body);
  const page = asRecord(root?.list);
  if (!page || !Array.isArray(page.keys)) {
    throw new Error("brain list response is missing list.keys");
  }
  const keys = page.keys.map((value, index) => {
    const key = asRecord(value);
    if (!key || typeof key.hash !== "string" || key.hash.length === 0) {
      throw new Error(`brain list response has an invalid key at index ${index}`);
    }
    if (key.range !== undefined && key.range !== null && typeof key.range !== "string") {
      throw new Error(`brain list response has an invalid range at index ${index}`);
    }
    return { hash: key.hash, range: typeof key.range === "string" ? key.range : null };
  });
  return {
    keys,
    hasMore: page.has_more === true,
    nextCursor: typeof page.next_cursor === "string" ? page.next_cursor : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
