export const OWNER_APP_ID = "lastsecrets";

export type FieldType =
  | "String"
  | { Array: "String" }
  | { Object: Record<string, FieldType> };

export type SchemaDefinition = {
  name: string;
  owner_app_id: string;
  descriptive_name: string;
  purpose_statement: string;
  schema_type: "Hash";
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
