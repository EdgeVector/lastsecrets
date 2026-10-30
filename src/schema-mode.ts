/** Declaration rules. Field names and record ownership are separate decisions. */
import { OWNER_APP_ID } from "./schema.ts";

type Entry = Record<string, unknown>;
const object = (value: unknown): Entry | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Entry : null;

export function requireOwnedSchemas(schemas: unknown[], version: unknown): void {
  const owned = schemas.map(object).filter((schema): schema is Entry => schema?.owner_app_id === OWNER_APP_ID);
  if (owned.some((schema) => schema.independent_fields !== true)) {
    throw new Error("Existing LastSecrets values require explicit schema conversion on a compatible LastDB release before setup or publication. No schema was declared.");
  }
  const capabilities = object(object(version)?.capabilities);
  if (capabilities?.owned_app_schemas_v1 !== true) {
    throw new Error("New LastSecrets schemas require LastDB with owned_app_schemas_v1. Upgrade LastDB before setup.");
  }
}

export function ownedDeclaration(body: unknown, schemaName: string): {identity: string; runtime: string} {
  const raw = object(body);
  const reply = object(raw?.data) ?? raw;
  // A converted home retains its literal runtime address. The public
  // definition identity is the stable config pin, not an assumed runtime name.
  if (reply?.independent_fields !== true || reply.app_id !== OWNER_APP_ID ||
      reply.schema_name !== schemaName || typeof reply.canonical !== "string" || !reply.canonical ||
      typeof reply.identity_hash !== "string" || !/^[a-f0-9]{64}$/.test(reply.identity_hash)) {
    throw new Error("LastDB did not confirm an independent app schema. No config was changed.");
  }
  return {identity:reply.identity_hash, runtime:reply.canonical};
}
