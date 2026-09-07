import { readConfig, type Config } from "./config.ts";
import { type LastDbClient, type QueryRow, redactKnownSecretWords } from "./lastdb.ts";
import { ALL_SECRETS_INDEX_KEY, lastSecretIndexSchema, lastSecretSchema, secretRef } from "./schema.ts";

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
  "schemaHash" | "schemaName" | "indexSchemaHash" | "indexSchemaName"
>;

export async function putSecret(
  client: LastDbClient,
  config: StorageConfig,
  input: SecretInput,
): Promise<SecretMetadata> {
  validateSecretInput(input);
  const existing = await client.queryByKey({
    schemaHash: schemaId(config),
    keyHash: input.slug,
    fields: SECRET_FIELDS,
  });
  const now = new Date().toISOString();
  const createdAt = existing ? rowToSecret(existing).createdAt : now;
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
      await client.updateRecord({ schemaHash: schemaId(config), keyHash: input.slug, fields });
    } else {
      await client.createRecord({ schemaHash: schemaId(config), keyHash: input.slug, fields });
    }
  } catch (err) {
    throw redactError(err, input.value);
  }

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
  await patchIndex(client, config, meta);
  return meta;
}

export async function getSecret(
  client: LastDbClient,
  config: Pick<Config, "schemaHash" | "schemaName">,
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
  config: Pick<Config, "indexSchemaHash" | "indexSchemaName">,
): Promise<SecretMetadata[]> {
  const row = await client.queryByKey({
    schemaHash: indexSchemaId(config),
    keyHash: ALL_SECRETS_INDEX_KEY,
    fields: INDEX_FIELDS,
  });
  return parseIndexEntries(row).sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function searchSecrets(
  client: LastDbClient,
  config: Pick<Config, "indexSchemaHash" | "indexSchemaName">,
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

function schemaId(config: Pick<Config, "schemaHash" | "schemaName">): string {
  return config.schemaName && config.schemaName.length > 0 ? config.schemaName : config.schemaHash;
}

function indexSchemaId(config: Pick<Config, "indexSchemaHash" | "indexSchemaName">): string {
  const id =
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

async function patchIndex(
  client: LastDbClient,
  config: Pick<Config, "indexSchemaHash" | "indexSchemaName">,
  meta: SecretMetadata,
): Promise<void> {
  const indexHash = indexSchemaId(config);
  const row = await client.queryByKey({
    schemaHash: indexHash,
    keyHash: ALL_SECRETS_INDEX_KEY,
    fields: INDEX_FIELDS,
  });
  const entries = parseIndexEntries(row).filter((e) => e.slug !== meta.slug);
  entries.push(meta);
  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  const fields = {
    key: ALL_SECRETS_INDEX_KEY,
    payload_json: JSON.stringify(entries),
    updated_at: new Date().toISOString(),
  };
  if (row) {
    await client.updateRecord({ schemaHash: indexHash, keyHash: ALL_SECRETS_INDEX_KEY, fields });
  } else {
    await client.createRecord({ schemaHash: indexHash, keyHash: ALL_SECRETS_INDEX_KEY, fields });
  }
}

function parseIndexEntries(row: QueryRow | null): SecretMetadata[] {
  const raw = row?.fields?.payload_json;
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isSecretMetadata) : [];
}

function isSecretMetadata(value: unknown): value is SecretMetadata {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.slug === "string" && typeof v.ref === "string";
}
