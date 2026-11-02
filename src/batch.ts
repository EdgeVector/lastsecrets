import { canonicalSchema } from "./canonical-vocabulary.ts";
import type { Transport } from "@lastdb/app-sdk";
import type { Config } from "./config.ts";
import type { QueryRow } from "./lastdb.ts";
import {
  ALL_SECRETS_INDEX_KEY, OWNER_APP_ID, apiVersionOf, lastSecretIndexSchema, lastSecretSchema, ownedHome, secretRef,
} from "./schema.ts";
import { INDEX_BUCKET_COUNT, indexBucketKey } from "./index-rows.ts";

export const DELETE_METADATA_FIELDS = lastSecretSchema.schema.fields.filter(
  (field) => field !== "secret_value",
);
export const DELETE_SLUG_LIMIT = 63;
/** The native limit of one `/api/queries/batch` and one `/api/conflicts/keys` request. */
const NATIVE_KEY_LIMIT = 64;
/** The slugs, the root index row and at most one bucket row per slug. */
const DELETE_READ_LIMIT = DELETE_SLUG_LIMIT + 1 + INDEX_BUCKET_COUNT;
type ObjectRecord = Record<string, unknown>;
export type ExactRead = { schema: string; key: string; fields: string[] };
type ConflictState = "clean" | "conflict" | "unknown";
/** One `selected_record_fields` result: the fields in request order and their states. */
type SelectedConflict = {
  state: ConflictState;
  fields: { state: ConflictState }[];
};
export type BatchMutation = {
  type: "mutation";
  schema: string;
  fields_and_values: ObjectRecord;
  key_value: { hash: string; range: null };
  mutation_type: "delete" | "update";
  expected?: { type: "value"; field: "payload_json"; value: string };
};
export type NativeBatchClient = {
  schemas(): Promise<unknown>;
  version(): Promise<unknown>;
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

/** Uses the existing owner transport. No declarations, grants, retries, or raw response errors. */
export function newNativeBatchClient(transport: Transport): NativeBatchClient {
  const send = async (method: "GET" | "POST", path: string, body?: unknown) => {
    let response;
    try {
      response = await transport.send(method, path, body === undefined ? undefined : { body });
    } catch {
      // The SDK transport error can contain a non-JSON response excerpt. Never retain its cause.
      throw new DeleteError("transport_outcome_unknown");
    }
    if (response.status !== 200) {
      throw new DeleteError(response.status === 409 ? "metadata_conflict" : "request_outcome_unconfirmed");
    }
    const parsed = object(response.body);
    if (parsed.ok !== true) throw new DeleteError("reply_not_acknowledged");
    return parsed;
  };
  const readChunk = async (reads: ExactRead[]): Promise<(QueryRow | null)[]> => {
    // Independent bounded reads share the normal owner transport. An absent
    // endpoint never proves clean; known query flags retain their old path.
    const [reply, selected] = await Promise.all([
      send("POST", "/api/queries/batch", {
        queries: reads.map((read) => ({
          schema_name: read.schema, fields: read.fields, filter: { HashKey: read.key }, limit: 2, offset: 0,
        })),
      }),
      send("POST", "/api/conflicts/keys", {
        keys: reads.map((read) => ({ schema_name: read.schema, fields: read.fields, hash: read.key })),
      }).then((reply) => parseSelectedConflicts(reply, reads)).catch(() => null),
    ]);
    if (reply.count !== reads.length || !Array.isArray(reply.results) || reply.results.length !== reads.length) {
      throw new DeleteError("read_batch_reply_ambiguous");
    }
    return reply.results.map((item, position) => parseExactRead(item, reads[position]!, selected?.[position]));
  };
  return {
    async schemas() { return send("GET", "/api/schemas"); },
    async version() { return send("GET", "/api/version"); },
    async readKeys(reads) {
      if (reads.length < 1 || reads.length > DELETE_READ_LIMIT) throw new DeleteError("invalid_read_count");
      // Each chunk fits the native per-request limit. Chunks run in parallel.
      const chunks: ExactRead[][] = [];
      for (let start = 0; start < reads.length; start += NATIVE_KEY_LIMIT) {
        chunks.push(reads.slice(start, start + NATIVE_KEY_LIMIT));
      }
      return (await Promise.all(chunks.map(readChunk))).flat();
    },
    async mutate(mutations) {
      const reply = await send("POST", "/api/mutations/batch", { mutations });
      const operations = object(reply.operations);
      const deleted = mutations.filter((item) => item.mutation_type === "delete").length;
      const updated = mutations.length - deleted;
      if (reply.count !== mutations.length || !Array.isArray(reply.mutation_ids) ||
          reply.mutation_ids.length !== mutations.length ||
          reply.mutation_ids.some((id) => typeof id !== "string" || id.length === 0) ||
          new Set(reply.mutation_ids).size !== mutations.length ||
          operations.total !== mutations.length || operations.deleted !== deleted ||
          operations.updated !== updated || operations.created !== 0 || operations.no_op !== 0 ||
          (reply.durability !== "queued" && reply.durability !== "durable")) {
        throw new DeleteError("mutation_reply_ambiguous");
      }
    },
  };
}

function object(value: unknown): ObjectRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DeleteError("reply_shape_ambiguous");
  return value as ObjectRecord;
}
function parseExactRead(item: unknown, read: ExactRead, selected?: SelectedConflict): QueryRow | null {
  const envelope = object(item);
  if (envelope.status !== 200) throw new DeleteError("key_read_unconfirmed");
  const reply = object(envelope.response);
  if (reply.ok !== true || !Array.isArray(reply.results) || reply.results.length > 1 ||
      reply.returned_count !== reply.results.length || reply.limit !== 2 || reply.offset !== 0 ||
      reply.has_more !== false || reply.next_cursor !== null ||
      (reply.total_count !== null && reply.total_count !== reply.results.length)) {
    throw new DeleteError("key_read_ambiguous");
  }
  if (reply.results.length === 0) return null;
  const row = object(reply.results[0]);
  const key = object(row.key);
  const fields = object(row.fields);
  if (key.hash !== read.key || key.range !== null || Object.keys(fields).some((field) => !read.fields.includes(field))) {
    throw new DeleteError("key_read_scope_mismatch");
  }
  const unknown = reply.conflict_flags === "unknown";
  if (reply.conflict_flags !== "known" && !unknown) throw new DeleteError("key_conflict_state_unknown");
  if (unknown && (!selected || selected.state !== "clean" || selected.fields.some((field) => field.state !== "clean"))) {
    throw new DeleteError("key_conflict_state_unknown");
  }
  // The record carries the conflict flag: false when known clean, "unknown"
  // when the page could not read its conflicts.
  const flag = row.has_conflicts;
  if (flag !== false && !(unknown && flag === "unknown")) {
    throw new DeleteError("key_conflict_state_ambiguous");
  }
  return { fields, key: { hash: read.key, range: null } };
}

function parseSelectedConflicts(reply: ObjectRecord, reads: ExactRead[]): SelectedConflict[] {
  if (reply.version !== 1 || reply.scope !== "selected_record_fields" || reply.count !== reads.length ||
      !Array.isArray(reply.results) || reply.results.length !== reads.length) {
    throw new DeleteError("selected_conflict_reply_ambiguous");
  }
  return reply.results.map((value, position) => {
    const result = object(value);
    if (!validConflictState(result.state) || !Array.isArray(result.fields) ||
        result.fields.length !== reads[position]!.fields.length) throw new DeleteError("selected_conflict_reply_ambiguous");
    const fields = result.fields.map(selectedRecordField);
    const combined = fields.some((field) => field.state === "unknown") ? "unknown" :
      fields.some((field) => field.state === "conflict") ? "conflict" : "clean";
    if (result.state !== combined) throw new DeleteError("selected_conflict_reply_ambiguous");
    return { state: result.state, fields };
  });
}
/**
 * One entry per selected field, in request order, with the node's field name
 * and its kept losing values. Only a field with kept values is in conflict.
 * The values are never retained.
 */
function selectedRecordField(value: unknown): SelectedConflict["fields"][number] {
  const field = object(value);
  if (typeof field.field !== "string" || field.field.length === 0 || !validConflictState(field.state) ||
      !Array.isArray(field.conflicts) || (field.state === "conflict") !== (field.conflicts.length > 0)) {
    throw new DeleteError("selected_conflict_reply_ambiguous");
  }
  return { state: field.state };
}
function validConflictState(value: unknown): value is ConflictState {
  return value === "clean" || value === "conflict" || value === "unknown";
}

/** `version` is the `GET /api/version` reply. Delete runs only on a node that owns every schema's values. */
export function resolveDeleteSchemas(body: unknown, config: Pick<Config,
  "schemaHash" | "schemaName" | "indexSchemaHash" | "indexSchemaName" | "schemaFieldAliases"
>, version: unknown): { secret: string; index: string } {
  if (!ownedHome(apiVersionOf(version))) throw new DeleteError("home_copy_required");
  const catalog = object(body);
  if (catalog.ready !== true || !Array.isArray(catalog.schemas)) throw new DeleteError("schema_catalog_not_ready");
  const secretCanonical = Boolean(config.schemaFieldAliases?.[config.schemaHash]);
  const indexCanonical = Boolean(config.indexSchemaHash && config.schemaFieldAliases?.[config.indexSchemaHash]);
  return {
    secret: resolveSchema(catalog.schemas, secretCanonical ? canonicalSchema(lastSecretSchema.schema) : lastSecretSchema.schema, config.schemaHash, config.schemaName, secretCanonical),
    index: resolveSchema(catalog.schemas, indexCanonical ? canonicalSchema(lastSecretIndexSchema.schema) : lastSecretIndexSchema.schema, config.indexSchemaHash, config.indexSchemaName, indexCanonical),
  };
}
function resolveSchema(schemas: unknown[], definition: typeof lastSecretSchema.schema,
  configuredHash?: string, configuredName?: string, canonical = false): string {
  let route = canonical ? configuredHash : configuredName || configuredHash;
  if (!configuredHash || !/^[a-f0-9]{64}$/.test(configuredHash) || !route) {
    throw new DeleteError("configured_schema_identity_mismatch");
  }
  // Every listed schema owns its values, so the identity alone selects the route.
  const owned = schemas.filter((value) => object(value).identity_hash === configuredHash);
  if (owned.length > 1) throw new DeleteError("schema_owner_identity_ambiguous");
  if (owned.length === 1) {
    const name = object(owned[0]).name;
    if (typeof name !== "string" || (configuredName && configuredName !== name)) throw new DeleteError("configured_schema_identity_mismatch");
    route = name;
  }
  // Pin the same literal route as get/put. Retirement only controls descriptive-name resolution.
  const matches = schemas.filter((value) => object(value).name === route);
  if (matches.length !== 1) throw new DeleteError("schema_owner_identity_ambiguous");
  const schema = object(matches[0]);
  const key = object(schema.key);
  if (schema.owner_app_id !== OWNER_APP_ID || schema.descriptive_name !== definition.descriptive_name ||
      schema.state !== "Available" || typeof schema.name_claim_retired !== "boolean" ||
      schema.identity_hash !== configuredHash ||
      schema.schema_type !== definition.schema_type || key.hash_field !== definition.key.hash_field ||
      (key.range_field !== undefined && key.range_field !== null) ||
      !Array.isArray(schema.fields) || schema.fields.length !== definition.fields.length ||
      new Set(schema.fields).size !== schema.fields.length ||
      !schema.fields.every((field) => typeof field === "string" && definition.fields.includes(field))) {
    throw new DeleteError("configured_schema_identity_mismatch");
  }
  return route;
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
type Rollup = { key: string; payload: string; entries: ObjectRecord[] };
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
  return { key, payload: row.fields.payload_json, entries };
}
function validTime(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}
/** One update per changed index row, each conditioned on the exact previous payload. */
export function rollupRepairs(schema: string, rollups: (Rollup | null)[], absent: string[]): BatchMutation[] {
  const removable = new Set(absent);
  const updatedAt = new Date().toISOString();
  return rollups.flatMap((rollup): BatchMutation[] => {
    if (!rollup) return [];
    const kept = rollup.entries.filter((entry) => !removable.has(entry.slug as string));
    if (kept.length === rollup.entries.length) return [];
    return [{
      type: "mutation", schema, mutation_type: "update", key_value: { hash: rollup.key, range: null },
      fields_and_values: { payload_json: JSON.stringify(kept), updated_at: updatedAt },
      expected: { type: "value", field: "payload_json", value: rollup.payload },
    }];
  });
}
export function rollupAbsentSlugs(rollups: (Rollup | null)[], slugs: string[]): string[] {
  return slugs.filter((slug) => !rollups.some((rollup) => rollup?.entries.some((entry) => entry.slug === slug)));
}
