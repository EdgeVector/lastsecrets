// Minimal read/update client for Brain (F-Brain) records over the local LastDB
// socket, scoped to exactly what the migration needs: enumerate candidate
// records, read their scannable text, and stage a single-field replacement that
// swaps a raw secret for a `lastsecrets://` locator.
//
// Brain owns its own schemas, and the migration must not assume a fixed field
// layout. Records are treated as opaque field bags; the migration scans string
// fields and rewrites them in place.

import {
  TransportError,
  UnexpectedResponseError,
  httpTransport,
  udsTransport,
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
  completeFields: Record<string, unknown>;
  revision: string;
  alternates: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type BrainKey = {
  hash: string;
  range: string | null;
};

export type BrainClient = {
  /** Page through the live keys for a schema without loading field values. */
  listKeys(schema: string): Promise<BrainKey[]>;
  /** Read one live record by its exact key. */
  queryByKey(schema: string, key: BrainKey, fields: string[]): Promise<BrainRecord | null>;
  /** Replace the field bag for a single record (targeted update, not mass rewrite). */
  updateRecord(schema: string, record: BrainRecord, fields: Record<string, unknown>): Promise<void>;
};

const LIST_PAGE_SIZE = 1000;

export function newBrainClient(opts: {
  nodeUrl?: string;
  userHash: string;
  socketPath?: string;
  socketPathOverride?: string;
  transport?: SdkTransport;
}): BrainClient {
  const nodeUrl = stripTrailingSlash(opts.nodeUrl ?? defaultNodeUrl());
  const socketPath = resolveSocketPath(opts.socketPathOverride, opts.socketPath);
  const defaultHeaders = { "X-User-Hash": opts.userHash, "X-LastDB-Client": "lastsecrets" };
  const sdkTransport: SdkTransport = opts.transport ?? (isLoopbackNodeUrl(nodeUrl)
    ? udsTransport(socketPath, defaultHeaders)
    : httpTransport(nodeUrl, defaultHeaders));
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
      return transportDataPath(async () => {
        const response = await sdkTransport.send("POST", "/api/query", { body: {
          schema_name: schema, filter: { HashRangeKeys: [[key.hash, key.range ?? ""]] }, limit: 2,
        } });
        const reply = asRecord(response.body);
        if (response.status !== 200 || reply?.ok === false || reply?.has_more !== false ||
            !Array.isArray(reply.results) || reply.results.length > 1) {
          throw new Error(`LastDB did not confirm the Brain record read (HTTP ${response.status}).`);
        }
        if (reply.results.length === 0) return null;
        const row = asRecord(reply.results[0]);
        const coordinate = asRecord(row?.key);
        const completeFields = asRecord(row?.fields);
        const alternates = asRecord(row?.alternates);
        const revision = row?.revision;
        if (coordinate?.hash !== key.hash || coordinate.range !== key.range || !completeFields || !alternates ||
            typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
          throw new Error("LastDB returned a different or incomplete Brain record.");
        }
        return {
          key: key.hash, range: key.range, revision, completeFields, alternates,
          metadata: asRecord(row?.metadata) ?? {},
          fields: Object.fromEntries(fields.filter((field) => Object.hasOwn(completeFields, field)).map((field) => [field, completeFields[field]])),
        };
      });
    },
    async updateRecord(schema, record, fields) {
      await transportDataPath(async () => {
        const response = await sdkTransport.send("POST", "/api/mutation", { body: {
          type: "mutation", schema, mutation_type: "replace", record: { ...record.completeFields, ...fields },
          key_value: { hash: record.key, range: record.range }, alternates: record.alternates,
          expected: { type: "revision", revision: record.revision },
          source_file_name: record.metadata.source_file_name ?? null,
          metadata: record.metadata.metadata ?? null, file: record.metadata.file ?? null,
          durability: "durable",
        } });
        const revision = asRecord(response.body)?.record_revision;
        if (response.status !== 200 || typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
          throw new Error(`LastDB did not confirm the Brain record write (HTTP ${response.status}).`);
        }
      });
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
