#!/usr/bin/env bun
// Write the schemas LastSecrets declares into lastdb-app.json.
// A registry app lists every schema it declares, with every field typed
// (decision A8). The list is the exact canonical definition that `init`
// declares on a fresh home. This reads source definitions only. It never
// contacts a node or Schema Service.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalSchema } from "../src/canonical-vocabulary.ts";
import { lastSecretIndexSchema, lastSecretSchema } from "../src/schema.ts";

const path = fileURLToPath(new URL("../lastdb-app.json", import.meta.url));
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.schemas = [lastSecretSchema, lastSecretIndexSchema].map(({ schema }) => canonicalSchema(schema));
for (const schema of manifest.schemas) {
  const untyped = schema.fields.filter((field: string) => schema.field_types[field] === undefined);
  if (untyped.length > 0) throw new Error(`${schema.name} has untyped fields: ${untyped.join(", ")}`);
}
writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Updated LastSecrets manifest with ${manifest.schemas.length} canonical owned schemas.`);
