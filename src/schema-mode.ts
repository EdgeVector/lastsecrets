/** Declaration rules. Field names and record ownership are separate decisions. */
import { OWNER_APP_ID, apiVersionOf, ownsValues } from "./schema.ts";
import { LastSecretsError } from "./lastdb.ts";

type Entry = Record<string, unknown>;
const object = (value: unknown): Entry | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Entry : null;

/** Returns the node API version, which the declare receipt needs. */
export function requireOwnedSchemas(schemas: unknown[], version: unknown): number {
  const apiVersion = apiVersionOf(version);
  const owned = schemas.map(object).filter((schema): schema is Entry => schema?.owner_app_id === OWNER_APP_ID);
  if (owned.some((schema) => !ownsValues(schema.independent_fields, apiVersion))) {
    throw new LastSecretsError("home_copy_required",
      "home_copy_required: This home holds LastSecrets values in the old shared-value layout. No schema was declared and the home is unchanged. " +
      "Move the values to a new home with the home copy (last-stack-lastdb-home-copy).");
  }
  const capabilities = object(object(version)?.capabilities);
  if (capabilities?.owned_app_schemas_v1 !== true) {
    throw new Error("New LastSecrets schemas require LastDB with owned_app_schemas_v1. Upgrade LastDB before setup.");
  }
  return apiVersion;
}

export function ownedDeclaration(body: unknown, schemaName: string, apiVersion: number): {identity: string; runtime: string} {
  const raw = object(body);
  const reply = object(raw?.data) ?? raw;
  // The public definition identity is the stable config pin, not an assumed runtime name.
  if (!reply || !ownsValues(reply.independent_fields, apiVersion) || reply.app_id !== OWNER_APP_ID ||
      reply.schema_name !== schemaName || typeof reply.canonical !== "string" || !reply.canonical ||
      typeof reply.identity_hash !== "string" || !/^[a-f0-9]{64}$/.test(reply.identity_hash)) {
    throw new Error("LastDB did not confirm an independent app schema. No config was changed.");
  }
  return {identity:reply.identity_hash, runtime:reply.canonical};
}
