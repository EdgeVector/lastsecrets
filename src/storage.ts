import { readConfig, type Config } from "./config.ts";
import { LastSecretsError, type LastDbClient, type QueryRow, redactKnownSecretWords } from "./lastdb.ts";
import { ALL_SECRETS_INDEX_KEY, lastSecretIndexSchema, lastSecretSchema, secretRef } from "./schema.ts";
import { INDEX_ROW_KEYS, INDEX_ROW_MAX_BYTES, indexBucketKey, storedPayloadBytes } from "./index-rows.ts";

import {
  DeleteError, absentSlugs, deleteProgress, deleteReads, deleteReceipt,
  resolveDeleteSchemas, rollupAbsentSlugs, rollupRepairs, strictRollups, validateDeleteSlugs,
} from "./batch.ts";

export type SecretInput = {
  slug: string;
  label: string;
  provider: string;
  purpose: string;
  environment: string;
  value: string;
};

export type LastSecret = {
  slug: string;
  label: string;
  provider: string;
  purpose: string;
  environment: string;
  secretValue: string;
  createdAt: string;
  updatedAt: string;
};

export type SecretMetadata = Omit<LastSecret, "secretValue"> & {
  ref: string;
};

export type AdminSecretMetadata = {
  slug: string;
  label: string;
  provider: string;
  purpose: string;
  env: string;
  updated_at: string;
};

export type AdminSecretsSlice = {
  app_id: "lastsecrets";
  schema: "lastsecrets.admin.slice.v1";
  captured_at: string;
  total: number;
  secrets: AdminSecretMetadata[];
};

export const SECRET_FIELDS = lastSecretSchema.schema.fields.slice();
export const INDEX_FIELDS = lastSecretIndexSchema.schema.fields.slice();
const REDACTED = "<redacted>";

type StorageConfig = Pick<
  Config,
  "schemaHash" | "schemaName" | "schemaFieldAliases" | "indexSchemaHash" | "indexSchemaName" | "schemaFieldAliases"
>;

/** Intentional exact-key deletion. Metadata repair is a separate, conditional write. */
export async function deleteSecrets(client: LastDbClient, config: StorageConfig, slugs: string[]) {
  validateDeleteSlugs(slugs);
  const progress = deleteProgress(slugs);
  try {
    const [catalog, version] = await Promise.all([client.nativeBatch.schemas(), client.nativeBatch.version()]);
    const schemas = resolveDeleteSchemas(catalog, config, version);
    const reads = deleteReads(schemas, slugs);
    const before = await client.nativeBatch.readKeys(reads);
    absentSlugs(before, slugs);
    strictRollups(before, slugs);
    // An uncertain request stops this sequence. Never retry a mutation here.
    progress.delete_outcome = "unknown";
    const deletes = slugs.flatMap((slug, index) => {
      const row = before[index];
      return row ? [{
        type: "mutation" as const, schema: schemas.secret, mutation_type: "delete" as const,
        record: {}, key_value: { hash: slug, range: null }, alternates: {},
        expected: { type: "revision" as const, revision: row.revision },
      }] : [];
    });
    if (deletes.length > 0) await client.nativeBatch.mutate(deletes);
    progress.delete_outcome = "acknowledged";
    // Fresh reads retain metadata for an observed recreated slug and current unrelated entries.
    const fresh = await client.nativeBatch.readKeys(reads);
    const absent = absentSlugs(fresh, slugs);
    progress.metadata_absent_refs = absent.map(secretRef);
    // One value-conditioned update for each index row that holds a removable entry.
    const repairs = rollupRepairs(schemas.index, strictRollups(fresh, slugs), absent);
    if (repairs.length > 0) {
      progress.metadata_cleanup = "unknown";
      await client.nativeBatch.mutate(repairs);
      progress.metadata_cleanup = "acknowledged";
    } else {
      // Never delete or create an index row to repair an absent entry.
      progress.metadata_cleanup = "not_needed";
    }
    const after = await client.nativeBatch.readKeys(reads);
    progress.metadata_absent_refs = absentSlugs(after, slugs).map(secretRef);
    progress.rollup_absent_refs = rollupAbsentSlugs(strictRollups(after, slugs), slugs).map(secretRef);
    progress.post_read = "completed";
    const complete = progress.metadata_absent_refs.length === slugs.length && progress.rollup_absent_refs.length === slugs.length;
    return deleteReceipt(progress, complete ? "complete" : "post_read_incomplete");
  } catch (err) {
    // Do not render response bodies, values, SDK causes, or JSON parser excerpts.
    return deleteReceipt(progress, err instanceof DeleteError ? err.code : "delete_incomplete");
  }
}

export async function putSecret(
  client: LastDbClient,
  config: StorageConfig,
  input: SecretInput,
): Promise<SecretMetadata> {
  validateSecretInput(input);
  const indexHash = indexSchemaId(config);
  const bucket = indexBucketKey(input.slug);
  // The two index rows that can hold this slug are read with the secret, so a
  // full bucket refuses the put before any write.
  const [existing, [root, row]] = await Promise.all([
    client.queryByKey({
      schemaHash: schemaId(config),
      keyHash: input.slug,
      fields: SECRET_FIELDS,
    }),
    client.queryByKeys({
      schemaHash: indexHash,
      keys: [ALL_SECRETS_INDEX_KEY, bucket],
      fields: INDEX_FIELDS,
    }),
  ]);
  const now = new Date().toISOString();
  const createdAt = existing ? rowToSecret(existing).createdAt : now;
  const meta = toMetadata({
    slug: input.slug,
    label: input.label,
    provider: input.provider,
    purpose: input.purpose,
    environment: input.environment,
    secretValue: input.value,
    createdAt,
    updatedAt: now,
  });
  const patch = planIndexPatch(bucket, root ?? null, row ?? null, meta);
  const fields = {
    slug: input.slug,
    label: input.label,
    provider: input.provider,
    purpose: input.purpose,
    environment: input.environment,
    secret_value: { value: input.value },
    created_at: createdAt,
    updated_at: now,
  };

  try {
    if (existing) {
      await client.updateRecord({ schemaHash: schemaId(config), keyHash: input.slug, fields, revision: existing.revision });
    } else {
      await client.createRecord({ schemaHash: schemaId(config), keyHash: input.slug, fields });
    }
  } catch (err) {
    throw redactError(err, input.value);
  }

  await writeIndexPatch(client, indexHash, patch, now);
  return meta;
}

export async function getSecret(
  client: LastDbClient,
  config: Pick<Config, "schemaHash" | "schemaName" | "schemaFieldAliases">,
  slug: string,
): Promise<LastSecret> {
  secretRef(slug);
  const row = await client.queryByKey({
    schemaHash: schemaId(config),
    keyHash: slug,
    fields: SECRET_FIELDS,
  });
  if (!row) throw new Error(`secret not found: ${slug}`);
  const secret = rowToSecret(row);
  // An empty value is not a successful fetch. Callers read stdout and act on the
  // exit code, so answering 0 with nothing on stdout tells every caller the
  // secret resolved to the empty string, and no caller can tell that apart from
  // a real empty secret. That reading starved the routinesd claude token and
  // stopped the routine fleet for 3h15m on 2026-09-07.
  if (secret.secretValue.length === 0) {
    throw new Error(`secret has no value: ${slug}`);
  }
  return secret;
}

export async function listSecrets(
  client: LastDbClient,
  config: Pick<Config, "indexSchemaHash" | "indexSchemaName" | "schemaFieldAliases">,
): Promise<SecretMetadata[]> {
  // One batch read of every index row. A later row wins for a slug, so a
  // bucket entry wins over a root entry (see index-rows.ts).
  const rows = await client.queryByKeys({
    schemaHash: indexSchemaId(config),
    keys: INDEX_ROW_KEYS,
    fields: INDEX_FIELDS,
  });
  const bySlug = new Map<string, SecretMetadata>();
  for (const row of rows) {
    for (const entry of parseIndexEntries(row)) bySlug.set(entry.slug, entry);
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function searchSecrets(
  client: LastDbClient,
  config: Pick<Config, "indexSchemaHash" | "indexSchemaName" | "schemaFieldAliases">,
  term: string,
): Promise<SecretMetadata[]> {
  const needle = term.trim().toLowerCase();
  if (!needle) return [];
  const all = await listSecrets(client, config);
  return all.filter((s) =>
    [s.slug, s.label, s.provider, s.purpose, s.environment]
      .join("\n")
      .toLowerCase()
      .includes(needle),
  );
}

export function formatMetadata(secret: SecretMetadata): string {
  return [
    secret.slug,
    secret.ref,
    `label=${secret.label}`,
    `provider=${secret.provider}`,
    `purpose=${secret.purpose}`,
    `env=${secret.environment}`,
    `value=${REDACTED}`,
  ].join("\t");
}

export function buildAdminSecretsSlice(
  secrets: SecretMetadata[],
  capturedAt = new Date().toISOString(),
): AdminSecretsSlice {
  const slim = secrets
    .map((secret) => ({
      slug: secret.slug,
      label: secret.label,
      provider: secret.provider,
      purpose: secret.purpose,
      env: secret.environment,
      updated_at: secret.updatedAt,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    app_id: "lastsecrets",
    schema: "lastsecrets.admin.slice.v1",
    captured_at: capturedAt,
    total: slim.length,
    secrets: slim,
  };
}

export function loadStorageConfig(path?: string): Config {
  return readConfig(path);
}

export function rowToSecret(row: QueryRow): LastSecret {
  const f = row.fields ?? {};
  return {
    slug: stringField(f, "slug"),
    label: stringField(f, "label"),
    provider: stringField(f, "provider"),
    purpose: stringField(f, "purpose"),
    environment: stringField(f, "environment"),
    secretValue: secretValueField(f.secret_value),
    createdAt: stringField(f, "created_at"),
    updatedAt: stringField(f, "updated_at"),
  };
}

function toMetadata(secret: LastSecret): SecretMetadata {
  return {
    slug: secret.slug,
    ref: secretRef(secret.slug),
    label: secret.label,
    provider: secret.provider,
    purpose: secret.purpose,
    environment: secret.environment,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
  };
}

function validateSecretInput(input: SecretInput): void {
  secretRef(input.slug);
  for (const field of ["label", "provider", "purpose", "environment"] as const) {
    if (input[field].trim().length === 0) {
      throw new Error(`${field} is required`);
    }
  }
  if (input.value.length === 0) throw new Error("secret value is required");
}

function stringField(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function secretValueField(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const raw = (value as Record<string, unknown>).value;
    return typeof raw === "string" ? raw : "";
  }
  return "";
}

function redactError(err: unknown, secretValue: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const redacted =
    secretValue.length > 0 ? message.split(secretValue).join(REDACTED) : message;
  return new Error(redactKnownSecretWords(redacted));
}

function schemaId(config: Pick<Config, "schemaHash" | "schemaName" | "schemaFieldAliases">): string {
  if (config.schemaFieldAliases?.[config.schemaHash]) return config.schemaHash;
  return config.schemaName && config.schemaName.length > 0 ? config.schemaName : config.schemaHash;
}

function indexSchemaId(config: Pick<Config, "indexSchemaHash" | "indexSchemaName" | "schemaFieldAliases">): string {
  const id = config.indexSchemaHash && config.schemaFieldAliases?.[config.indexSchemaHash]
    ? config.indexSchemaHash :
    config.indexSchemaName && config.indexSchemaName.length > 0
      ? config.indexSchemaName
      : config.indexSchemaHash;
  if (!id) {
    throw new Error(
      "LastSecretIndex schema is not resolved on this config; run `lastsecrets init` first.",
    );
  }
  return id;
}

type IndexPatch = {
  bucket: string;
  bucketRevision: string | null;
  rootRevision: string | null;
  bucketPayload: string;
  /** The root payload without this slug, or null when the root row does not hold it. */
  rootPayload: string | null;
};

/**
 * The index writes of one put: the slug's entry goes to its bucket row, and
 * leaves the root row if the root row holds it. Other items stay byte-for-byte
 * as parsed. An unreadable bucket payload is rebuilt (as the single row was
 * before buckets); an unreadable root payload is never rewritten.
 */
function planIndexPatch(
  bucket: string,
  root: QueryRow | null,
  row: QueryRow | null,
  meta: SecretMetadata,
): IndexPatch {
  const items = (payloadItems(row) ?? []).filter((item) => itemSlug(item) !== meta.slug);
  items.push(meta);
  items.sort((a, b) => itemSlug(a).localeCompare(itemSlug(b)));
  const bucketPayload = JSON.stringify(items);
  const bytes = storedPayloadBytes(bucketPayload);
  if (bytes > INDEX_ROW_MAX_BYTES) {
    throw new LastSecretsError(
      "index_row_full",
      `The LastSecrets index row ${bucket} would hold ${bytes} bytes; the cap is ${INDEX_ROW_MAX_BYTES} bytes. Nothing was written.`,
    );
  }
  const rootItems = payloadItems(root);
  const rootKept = rootItems?.filter((item) => itemSlug(item) !== meta.slug);
  return {
    bucket,
    bucketRevision: row?.revision ?? null,
    rootRevision: root?.revision ?? null,
    bucketPayload,
    rootPayload: rootItems && rootKept && rootKept.length !== rootItems.length ? JSON.stringify(rootKept) : null,
  };
}

async function writeIndexPatch(
  client: LastDbClient,
  indexHash: string,
  patch: IndexPatch,
  now: string,
): Promise<void> {
  const fields = { key: patch.bucket, payload_json: patch.bucketPayload, updated_at: now };
  if (patch.bucketRevision !== null) {
    await client.updateRecord({ schemaHash: indexHash, keyHash: patch.bucket, fields, revision: patch.bucketRevision });
  } else {
    await client.createRecord({ schemaHash: indexHash, keyHash: patch.bucket, fields });
  }
  // Remove the root entry only after the bucket write. A failure between the
  // two writes leaves the entry in both rows (readers take the bucket entry),
  // never in neither.
  if (patch.rootPayload !== null && patch.rootRevision !== null) {
    await client.updateRecord({
      schemaHash: indexHash,
      keyHash: ALL_SECRETS_INDEX_KEY,
      revision: patch.rootRevision,
      fields: { key: ALL_SECRETS_INDEX_KEY, payload_json: patch.rootPayload, updated_at: now },
    });
  }
}

/** The parsed payload_json array of an index row; null when the row is absent or unreadable. */
function payloadItems(row: QueryRow | null): unknown[] | null {
  const raw = row?.fields?.payload_json;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function itemSlug(item: unknown): string {
  if (typeof item !== "object" || item === null) return "";
  const slug = (item as Record<string, unknown>).slug;
  return typeof slug === "string" ? slug : "";
}

function parseIndexEntries(row: QueryRow | null): SecretMetadata[] {
  return (payloadItems(row) ?? []).filter(isSecretMetadata);
}

function isSecretMetadata(value: unknown): value is SecretMetadata {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.slug === "string" && typeof v.ref === "string";
}
