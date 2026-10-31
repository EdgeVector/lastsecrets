export const OWNER_APP_ID = "lastsecrets";

// LastDB API 13 (lastdb #803) is the first node that refuses a home with the
// retired shared-value layout at startup. Every schema such a node lists owns
// its values, so its replies may omit the per-schema `independent_fields` key
// (lastdb removes it in stage 2 of the protein removal). An explicit `false`
// still means "not owned", and an older node must still send `true`.
export const OWNED_HOME_API_VERSION = 13;

/** Whether a node reply's `independent_fields` value confirms owned values. */
export const ownsValues = (independentFields: unknown, apiVersion: number): boolean =>
  independentFields === true ||
  (independentFields === undefined && apiVersion >= OWNED_HOME_API_VERSION);

/** `api_version` from a `GET /api/version` reply (bare or in a `data` envelope); 0 when absent. */
export function apiVersionOf(reply: unknown): number {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const body = isObject(reply) && isObject(reply.data) ? reply.data : reply;
  return isObject(body) && typeof body.api_version === "number" ? body.api_version : 0;
}

export type FieldType =
  | "String"
  | "DateTime"
  | { Array: "String" }
  | { Object: Record<string, FieldType> };

export type SchemaDefinition = {
  name: string;
  owner_app_id: string;
  descriptive_name: string;
  purpose_statement: string;
  schema_type: "Hash";
  /** Definitions can be reused without sharing this schema's record values. */
  independent_fields?: boolean;
  key: { hash_field: string };
  fields: string[];
  field_types: Record<string, FieldType>;
  field_descriptions: Record<string, string>;
  field_classifications: Record<string, string[]>;
  field_data_classifications: Record<
    string,
    { sensitivity_level: number; data_domain: string }
  >;
};

export type AddSchemaRequest = {
  schema: SchemaDefinition;
  mutation_mappers: Record<string, string>;
};

const PUBLIC = { sensitivity_level: 0, data_domain: "metadata" };
const SECRET = { sensitivity_level: 3, data_domain: "secret" };

export const lastSecretSchema: AddSchemaRequest = {
  schema: {
    name: "LastSecret",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "LastSecret",
    purpose_statement:
      "Local secret record whose raw value is intentionally excluded from automatic search indexes",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [
      "slug",
      "label",
      "provider",
      "purpose",
      "environment",
      "secret_value",
      "created_at",
      "updated_at",
    ],
    field_types: {
      slug: "String",
      label: "String",
      provider: "String",
      purpose: "String",
      environment: "String",
      secret_value: { Object: { value: "String" } },
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      slug: "stable id used in lastsecrets:// references",
      label: "human-readable non-secret name",
      provider: "service or system the secret belongs to",
      purpose: "non-secret purpose for search and review",
      environment: "dev, staging, prod, local, or similar non-secret scope",
      secret_value: "raw secret payload; never automatically indexed",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: {
      label: ["word"],
      provider: ["word"],
      purpose: ["word"],
      environment: ["word"],
      secret_value: ["secret", "no_index"],
    },
    field_data_classifications: {
      slug: PUBLIC,
      label: PUBLIC,
      provider: PUBLIC,
      purpose: PUBLIC,
      environment: PUBLIC,
      secret_value: SECRET,
      created_at: PUBLIC,
      updated_at: PUBLIC,
    },
  },
  mutation_mappers: {},
};

/** Fixed key of the single rollup row in {@link lastSecretIndexSchema}. */
export const ALL_SECRETS_INDEX_KEY = "__all__";

/**
 * Thin metadata-only rollup of every LastSecret so `list`/`search` point-read
 * one row instead of an unfiltered scan of the (secret-bearing) LastSecret
 * schema. Patched on every put; never carries `secret_value`.
 */
export const lastSecretIndexSchema: AddSchemaRequest = {
  schema: {
    name: "LastSecretIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "LastSecretIndex",
    purpose_statement:
      "Metadata-only rollup of every LastSecret so list/search never full-scan the secret-bearing schema",
    schema_type: "Hash",
    key: { hash_field: "key" },
    fields: ["key", "payload_json", "updated_at"],
    field_types: {
      key: "String",
      payload_json: "String",
      updated_at: "String",
    },
    field_descriptions: {
      key: `index row name, always "${ALL_SECRETS_INDEX_KEY}" for the single rollup row`,
      payload_json: "JSON array of non-secret SecretMetadata rows",
      updated_at: "RFC 3339 timestamp of the last index patch",
    },
    field_classifications: {},
    field_data_classifications: {
      key: PUBLIC,
      payload_json: PUBLIC,
      updated_at: PUBLIC,
    },
  },
  mutation_mappers: {},
};

export function secretRef(slug: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw new Error(`invalid LastSecrets slug: ${slug}`);
  }
  return `lastsecrets://${slug}`;
}

export function searchableFields(schema: SchemaDefinition): string[] {
  return Object.entries(schema.field_classifications)
    .filter(([, classifications]) => {
      const lower = classifications.map((value) => value.toLowerCase());
      return (
        lower.includes("word") &&
        !lower.includes("secret") &&
        !lower.includes("no_index") &&
        !lower.includes("no-index")
      );
    })
    .map(([field]) => field)
    .sort();
}
