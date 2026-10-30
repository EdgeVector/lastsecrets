// Public replay confirms registered definitions. It supplies no publisher authority.
import {writeFileSync} from "node:fs";
import {join, resolve} from "node:path";

const [baseline, candidate, output] = process.argv.slice(2);
if (process.env.GITHUB_ACTIONS !== "true" || !baseline || !candidate || !output) {
  throw Error("Run this definition check only in CI with both exact source paths and an output path");
}
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,stable(v)])) : value;
const same = (a,b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const results = [];
for (const [label, path] of [["baseline",baseline],["candidate",candidate]]) {
  const root = resolve(path);
  const definitions = await import(join(root,"src/schema.ts"));
  const {canonicalSchema} = await import(join(root,"src/canonical-vocabulary.ts"));
  await Promise.all([definitions.lastSecretSchema,definitions.lastSecretIndexSchema].map(async(entry) => {
    const schema = canonicalSchema(entry.schema);
    const response = await fetch("https://axo709qs11.execute-api.us-east-1.amazonaws.com/v1/schemas", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({schema,mutation_mappers:{}}), signal:AbortSignal.timeout(60000),
    });
    const raw = await response.json();
    const body = raw.data ?? raw;
    const stored = body.schema ?? body;
    const exact = response.status === 200 && stored.owner_app_id === schema.owner_app_id &&
      stored.descriptive_name === schema.descriptive_name && /^[a-f0-9]{64}$/.test(stored.identity_hash ?? "") &&
      stored.schema_type === schema.schema_type &&
      same([stored.key?.hash_field,stored.key?.range_field ?? null],[schema.key.hash_field,null]) &&
      same([...(stored.fields ?? [])].sort(),[...schema.fields].sort()) &&
      same(stored.field_descriptions,schema.field_descriptions) &&
      schema.fields.every((field) => same(stored.field_types?.[field],schema.field_types[field]));
    results.push({label,schema:schema.descriptive_name,status:response.status,exact_definition:exact});
  }));
}
writeFileSync(output,JSON.stringify({definitions:results,complete:results.length === 4 && results.every((item) => item.exact_definition)},null,2)+"\n");
for (const item of results) console.log(JSON.stringify(item));
if (results.length !== 4 || results.some((item) => !item.exact_definition)) {
  throw Error("Publish the exact LastSecrets definitions through their registered owner before the comparison");
}
