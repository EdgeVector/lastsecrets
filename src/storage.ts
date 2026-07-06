import { readConfig, type Config } from "./config.ts";
import { type LastDbClient, type QueryRow, redactKnownSecretWords } from "./lastdb.ts";
import { lastSecretSchema, secretRef } from "./schema.ts";

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

export const SECRET_FIELDS = lastSecretSchema.schema.fields.slice();
const REDACTED = "<redacted>";

export async function putSecret(
  client: LastDbClient,
  config: Pick<Config, "schemaHash" | "schemaName">,
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

  return toMetadata({
    slug: input.slug,
    label: input.label,
    provider: input.provider,
    purpose: input.purpose,
    environment: input.environment,
    secretValue: input.value,
    createdAt,
    updatedAt: now,
  });
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
  return rowToSecret(row);
}

export async function listSecrets(
  client: LastDbClient,
  config: Pick<Config, "schemaHash" | "schemaName">,
): Promise<SecretMetadata[]> {
  const rows = await client.queryAll({ schemaHash: schemaId(config), fields: SECRET_FIELDS });
  return rows.map(rowToSecret).map(toMetadata).sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function searchSecrets(
  client: LastDbClient,
  config: Pick<Config, "schemaHash" | "schemaName">,
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
