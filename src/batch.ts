import {
  AppApiError, TransportError,
  type AppApiMutation, type AppApiReadResult, type AppApiWriteResult, type RowFields,
} from "@lastdb/app-sdk";
import type { Config } from "./config.ts";
import type { QueryRow } from "./lastdb.ts";
import {
  ALL_SECRETS_INDEX_KEY, LAST_SECRET_INDEX_SCHEMA, LAST_SECRET_SCHEMA, lastSecretIndexSchema, lastSecretSchema, secretRef,
} from "./schema.ts";
import { INDEX_BUCKET_COUNT, indexBucketKey } from "./index-rows.ts";

export const DELETE_METADATA_FIELDS = lastSecretSchema.schema.fields.filter(
  (field) => field !== "secret_value",
);
export const DELETE_SLUG_LIMIT = 63;
/** The app API accepts at most 64 reads in one list. */
const NATIVE_KEY_LIMIT = 64;
/** The slugs, the root index row and at most one bucket row per slug. */
const DELETE_READ_LIMIT = DELETE_SLUG_LIMIT + 1 + INDEX_BUCKET_COUNT;
type ObjectRecord = Record<string, unknown>;
export type ExactRead = { schema: string; key: string; fields: string[] };
export type BatchMutation = {
  type: "mutation";
  schema: string;
  record: ObjectRecord;
  key_value: { hash: string; range: null };
  alternates: Record<string, never>;
  mutation_type: "delete" | "replace";
  expected: { type: "revision"; revision: string };
};
export type AppPlane = {
  read(reads: readonly { schema: string; key: { hash: string; range: null }; limit: number }[]): Promise<AppApiReadResult[]>;
  write(mutations: readonly AppApiMutation[]): Promise<AppApiWriteResult>;
};
export type NativeBatchClient = {
  readKeys(reads: ExactRead[]): Promise<(QueryRow | null)[]>;
  mutate(mutations: BatchMutation[]): Promise<void>;
};
export class DeleteError extends Error {
  constructor(readonly code: string) {
    super(`LastSecrets delete: ${code}.`);
    this.name = "DeleteError";
  }
}
export type DeleteProgress = {
  refs: string[];
  delete_outcome: "not_sent" | "unknown" | "acknowledged";
  metadata_cleanup: "not_attempted" | "not_needed" | "unknown" | "acknowledged";
  post_read: "not_completed" | "completed";
  metadata_absent_refs: string[];
  rollup_absent_refs: string[];
};
export function deleteProgress(slugs: string[]): DeleteProgress {
  return {
    refs: slugs.map(secretRef), delete_outcome: "not_sent", metadata_cleanup: "not_attempted",
    post_read: "not_completed", metadata_absent_refs: [], rollup_absent_refs: [],
  };
}
export function deleteReceipt(progress: DeleteProgress, code: string) {
  const ok = code === "complete";
  return {
    schema: "lastsecrets.delete.v1", ok, code, ...progress,
    scope: "local_lastdb", atomic: false, provider_revoked: false,
    full_record_absence_verified: false, secret_value_tip_absence_verified: false,
    historical_erasure_proved: false, backup_erasure_proved: false,
  };
}
export function validateDeleteSlugs(slugs: string[]): void {
  if (slugs.length < 1 || slugs.length > DELETE_SLUG_LIMIT) throw new DeleteError("invalid_slug_count");
  if (new Set(slugs).size !== slugs.length) throw new DeleteError("duplicate_slug");
  for (const slug of slugs) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new DeleteError("invalid_slug");
  }
}

/** Uses the app API. No declarations, grants, retries, or raw response bodies. */
export function newNativeBatchClient(plane: AppPlane): NativeBatchClient {
  const refuse = (err: unknown): never => {
    // Never retain an SDK cause. Its body can quote a response.
    if (err instanceof AppApiError) {
      throw new DeleteError(err.status === 409 ? "metadata_conflict" : "request_outcome_unconfirmed");
    }
    if (err instanceof TransportError) throw new DeleteError("transport_outcome_unknown");
    throw new DeleteError("request_outcome_unconfirmed");
  };
  const readChunk = async (reads: ExactRead[]): Promise<(QueryRow | null)[]> => {
    let results: AppApiReadResult[];
    try {
      results = await plane.read(reads.map((read) => ({
        schema: read.schema, key: { hash: read.key, range: null }, limit: 2,
      })));
    } catch (err) {
      return refuse(err);
    }
    if (results.length !== reads.length) throw new DeleteError("read_batch_reply_ambiguous");
    return results.map((item, position) => parseExactRead(item, reads[position]!));
  };
  return {
    async readKeys(reads) {
      if (reads.length < 1 || reads.length > DELETE_READ_LIMIT) throw new DeleteError("invalid_read_count");
      // Each chunk fits the app API per-request limit. Chunks run in parallel.
      const chunks: ExactRead[][] = [];
      for (let start = 0; start < reads.length; start += NATIVE_KEY_LIMIT) {
        chunks.push(reads.slice(start, start + NATIVE_KEY_LIMIT));
      }
      return (await Promise.all(chunks.map(readChunk))).flat();
    },
    async mutate(mutations) {
      let reply: AppApiWriteResult;
      try {
        reply = await plane.write(mutations.map(toAppWrite));
      } catch (err) {
        return refuse(err);
      }
      if (reply.written !== mutations.length || reply.revisions.length !== mutations.length ||
          reply.revisions.some((id) => typeof id !== "string" || id.length === 0)) {
        throw new DeleteError("mutation_reply_ambiguous");
      }
    },
  };
}

function toAppWrite(item: BatchMutation): AppApiMutation {
  const key = { hash: item.key_value.hash, range: null };
  if (item.mutation_type === "delete") {
    return { op: "delete", schema: item.schema, key, revision: item.expected.revision };
  }
  return {
    op: "replace", schema: item.schema, key, revision: item.expected.revision,
    record: item.record as RowFields,
  };
}

function object(value: unknown): ObjectRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DeleteError("reply_shape_ambiguous");
  return value as ObjectRecord;
}
function parseExactRead(item: AppApiReadResult, read: ExactRead): QueryRow | null {
  // A per-item error is a missing schema or a refusal, not an absent key.
  if ("error" in item) throw new DeleteError("key_read_unconfirmed");
  if (!("records" in item) || item.next_cursor !== null || item.records.length > 1) {
    throw new DeleteError("key_read_ambiguous");
  }
  if (item.records.length === 0) return null;
  const row = item.records[0]!;
  const fields = object(row.record);
  if (row.key.hash !== read.key || row.key.range !== null ||
      typeof row.revision !== "string" || row.revision.length === 0) {
    throw new DeleteError("key_read_scope_mismatch");
  }
  return {
    fields: Object.fromEntries(read.fields.filter((field) => Object.hasOwn(fields, field)).map((field) => [field, fields[field]])),
    key: { hash: read.key, range: null },
    revision: row.revision,
  };
}

export function resolveDeleteSchemas(config: Pick<Config,
  "schemaHash" | "schemaName" | "indexSchemaHash" | "indexSchemaName"
>): { secret: string; index: string } {
  return {
    secret: configuredRoute(config.schemaName, config.schemaHash, LAST_SECRET_SCHEMA),
    index: configuredRoute(config.indexSchemaName, config.indexSchemaHash, LAST_SECRET_INDEX_SCHEMA),
  };
}
function configuredRoute(name: string | undefined, legacy: string | undefined, expected: string): string {
  if (name === expected || legacy === expected) return expected;
  throw new DeleteError("configured_schema_identity_mismatch");
}
/** The index rows that can hold an entry of these slugs: the root row, then each bucket row once. */
export function deleteIndexKeys(slugs: string[]): string[] {
  return [ALL_SECRETS_INDEX_KEY, ...[...new Set(slugs.map(indexBucketKey))].sort()];
}
export function deleteReads(schemas: { secret: string; index: string }, slugs: string[]): ExactRead[] {
  return [
    ...slugs.map((key) => ({ schema: schemas.secret, key, fields: DELETE_METADATA_FIELDS })),
    ...deleteIndexKeys(slugs).map((key) => ({ schema: schemas.index, key, fields: lastSecretIndexSchema.schema.fields })),
  ];
}
export function absentSlugs(rows: (QueryRow | null)[], slugs: string[]): string[] {
  if (rows.length !== slugs.length + deleteIndexKeys(slugs).length) throw new DeleteError("metadata_batch_ambiguous");
  return slugs.filter((slug, position) => {
    const row = rows[position];
    if (!row) return true;
    if (row.fields.slug !== slug || DELETE_METADATA_FIELDS.some((field) => typeof row.fields[field] !== "string" || !row.fields[field])) {
      throw new DeleteError("secret_metadata_ambiguous");
    }
    if (!validTime(row.fields.created_at) || !validTime(row.fields.updated_at)) throw new DeleteError("secret_metadata_version_invalid");
    return false;
  });
}
const METADATA_ENTRY_FIELDS = ["slug", "ref", "label", "provider", "purpose", "environment", "createdAt", "updatedAt"];
type Rollup = { key: string; revision: string; entries: ObjectRecord[] };
/** The index rows of {@link deleteReads}, in {@link deleteIndexKeys} order. An absent row is null. */
export function strictRollups(rows: (QueryRow | null)[], slugs: string[]): (Rollup | null)[] {
  const keys = deleteIndexKeys(slugs);
  const indexRows = rows.slice(slugs.length);
  if (indexRows.length !== keys.length) throw new DeleteError("metadata_batch_ambiguous");
  return indexRows.map((row, position) => strictRollup(row, keys[position]!));
}
function strictRollup(row: QueryRow | null, key: string): Rollup | null {
  if (!row) return null;
  if (row.fields.key !== key || typeof row.fields.payload_json !== "string" || !validTime(row.fields.updated_at)) {
    throw new DeleteError("rollup_metadata_ambiguous");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(row.fields.payload_json); } catch { throw new DeleteError("rollup_payload_invalid"); }
  if (!Array.isArray(parsed)) throw new DeleteError("rollup_payload_invalid");
  const seen = new Set<string>();
  const entries = parsed.map((value) => {
    const entry = object(value);
    if (Object.keys(entry).length !== METADATA_ENTRY_FIELDS.length ||
        METADATA_ENTRY_FIELDS.some((field) => typeof entry[field] !== "string" || !entry[field]) ||
        !validTime(entry.createdAt) || !validTime(entry.updatedAt)) throw new DeleteError("rollup_entry_invalid");
    const slug = entry.slug as string;
    // A bucket row holds only its own slugs, so the rows read here are the
    // only rows that can hold a named slug. The root row can hold any slug.
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug) || entry.ref !== `lastsecrets://${slug}` || seen.has(slug) ||
        (key !== ALL_SECRETS_INDEX_KEY && indexBucketKey(slug) !== key)) {
      throw new DeleteError("rollup_entry_identity_ambiguous");
    }
    seen.add(slug);
    return entry;
  });
  return { key, revision: row.revision, entries };
}
function validTime(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}
/** One complete replacement per changed index row, guarded by its observed revision. */
export function rollupRepairs(schema: string, rollups: (Rollup | null)[], absent: string[]): BatchMutation[] {
  const removable = new Set(absent);
  const updatedAt = new Date().toISOString();
  return rollups.flatMap((rollup): BatchMutation[] => {
    if (!rollup) return [];
    const kept = rollup.entries.filter((entry) => !removable.has(entry.slug as string));
    if (kept.length === rollup.entries.length) return [];
    return [{
      type: "mutation", schema, mutation_type: "replace", key_value: { hash: rollup.key, range: null },
      alternates: {},
      record: { key: rollup.key, payload_json: JSON.stringify(kept), updated_at: updatedAt },
      expected: { type: "revision", revision: rollup.revision },
    }];
  });
}
export function rollupAbsentSlugs(rollups: (Rollup | null)[], slugs: string[]): string[] {
  return slugs.filter((slug) => !rollups.some((rollup) => rollup?.entries.some((entry) => entry.slug === slug)));
}
