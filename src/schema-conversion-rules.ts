/** Definition, membership and retirement rules. These rules never fetch values. */
import { aliasesFor, canonicalSchema, profilesFor } from "./canonical-vocabulary.ts";
import { type Config } from "./config.ts";
import { type LastDbClient } from "./lastdb.ts";
import { OWNER_APP_ID, lastSecretSchema, lastSecretIndexSchema, type SchemaDefinition } from "./schema.ts";
import { data, fail, identity, object, same, sha, stable, type ConversionScope, type ConversionRequest, type ObjectValue } from "./conversion-scope.ts";

type Source = {
  definition: SchemaDefinition; canonical: boolean; source: ObjectValue; request: ConversionRequest;
  metadata: ConversionScope["source_metadata"][string];
};
const tags = (value: unknown): string[] => Array.isArray(value)
  ? value.map((item) => String(item).toLowerCase().replace(/[-_]/g, "")) : [];
export async function schemaMetadata(client: LastDbClient, name: string): Promise<ObjectValue> {
  const response = data(await client.request(`/api/schema/${encodeURIComponent(name)}`, "GET"));
  return object(response.schema ?? response);
}
function privacy(source: ObjectValue, field: string, expected: SchemaDefinition): void {
  const actual = object(object(source.field_data_classifications)[field]);
  const required = expected.field_data_classifications[field]!;
  if (!Number.isSafeInteger(actual.sensitivity_level) || Number(actual.sensitivity_level) < required.sensitivity_level ||
      String(actual.data_domain).toLowerCase() !== required.data_domain.toLowerCase() ||
      (expected.field_classifications[field] ?? []).filter((tag) => ["secret", "noindex"].includes(tags([tag])[0]!))
        .some((tag) => !tags(object(source.field_classifications)[field]).includes(tags([tag])[0]!))) {
    fail("An installed field lacks its required secret, no_index, or data privacy classification.");
  }
}
function definition(source: ObjectValue, local: SchemaDefinition) {
  const canonical = canonicalSchema(local);
  const expected = Array.isArray(source.fields) && same([...source.fields].sort(), [...canonical.fields].sort()) ? canonical : local;
  if (!identity(source.identity_hash) || source.owner_app_id !== OWNER_APP_ID || typeof source.name !== "string" || !source.name ||
      source.descriptive_name !== expected.descriptive_name || source.schema_type !== expected.schema_type ||
      !Array.isArray(source.fields) || !same([...source.fields].sort(), [...expected.fields].sort()) ||
      !same([object(source.key).hash_field, object(source.key).range_field ?? null], [expected.key.hash_field, null]) ||
      !same(source.field_types, expected.field_types) || !same(source.field_descriptions, expected.field_descriptions) ||
      Object.keys(object(source.transform_fields)).length || Object.keys(object(source.alternate_keys)).length) {
    fail("An installed schema differs from the app definition. Review it before conversion.");
  }
  for (const field of expected.fields) privacy(source, field, expected);
  return {expected, canonical: expected === canonical};
}
function metadata(source: ObjectValue): Source["metadata"] {
  const properties = ["name", "identity_hash", "owner_app_id", "descriptive_name", "schema_type", "fields", "key",
    "field_types", "field_descriptions", "field_classifications", "field_data_classifications", "field_hashes", "field_versions"];
  const definition = Object.fromEntries(properties.map((key) => [key, source[key]]));
  definition.fields = [...source.fields as string[]].sort();
  return {definition_sha256: sha(stable(definition)),
    mappers_sha256: sha(stable(source.field_mappers ?? {}))};
}
export async function conversionSources(client: LastDbClient, cfg: Config, capabilities: ObjectValue): Promise<Source[]> {
  const entries = [
    {pin:cfg.schemaHash, definition:lastSecretSchema.schema, member:"secret_value"},
    {pin:cfg.indexSchemaHash, definition:lastSecretIndexSchema.schema, member:"payload_json"},
  ];
  if (entries.some(({pin}) => !identity(pin)) || new Set(entries.map(({pin}) => pin)).size !== 2) {
    fail("Two distinct saved definition identities are required.");
  }
  const sources = await Promise.all(entries.map(async(entry): Promise<Source> => {
    // Older schemaName values address namespace aliases, not the kept data source.
    // The saved definition identity resolves the actual runtime on both models.
    const source = await schemaMetadata(client, entry.pin!);
    const {canonical} = definition(source, entry.definition);
    const profile = cfg.schemaFieldAliases?.[entry.pin!] ?? cfg.schemaFieldAliases?.[String(source.name)];
    if (source.identity_hash !== entry.pin || (canonical ? !same(profile, aliasesFor(entry.definition)) : profile !== undefined)) {
      fail("The saved identity or field aliases differ from the installed definition.");
    }
    const mappings = object(source.field_mappers);
    if (Object.keys(mappings).length && (source.independent_fields === true ||
        capabilities.app_schema_private_mapper_conversion_v1 !== true || Object.values(mappings).some((item) => typeof item !== "string"))) {
      fail("Mapped sources require the engine's atomic app_schema_private_mapper_conversion_v1 proof.");
    }
    const member = canonical ? aliasesFor(entry.definition)[entry.member]! : entry.member;
    return {definition:entry.definition, canonical, source, metadata:metadata(source), request:{
      schema:String(source.name), expected_identity:entry.pin!, alternate_keys:{}, membership:{kind:"field_exists", field:member}}};
  }));
  if (new Set(sources.map(({request}) => request.schema)).size !== 2) fail("The two record types resolve to the same schema.");
  return sources;
}
export function targetConfig(cfg: Config, sources: Source[]): Config {
  const profiles = Object.assign({}, cfg.schemaFieldAliases, ...sources.filter(({canonical}) => canonical)
    .map(({definition, request}) => profilesFor(definition, [request.expected_identity, request.schema])));
  return {...cfg, schemaName:sources[0]!.request.schema, indexSchemaName:sources[1]!.request.schema,
    schemaFieldAliases:Object.keys(profiles).length ? profiles : undefined};
}
export function checkMetadata(sources: Source[], scope: ConversionScope, published: boolean): void {
  if (!same(Object.keys(scope.source_metadata).sort(), sources.map(({request}) => request.schema).sort())) fail("The saved metadata scope differs.");
  for (const {source, request, metadata:current} of sources) {
    const saved = scope.source_metadata[request.schema]!;
    if (saved.definition_sha256 !== current.definition_sha256 || (published && source.independent_fields !== true) ||
        (source.independent_fields === true ? Object.keys(object(source.field_mappers)).length > 0 : saved.mappers_sha256 !== current.mappers_sha256)) {
      fail("The installed field definitions, privacy, ownership, or source authority changed.");
    }
  }
}
export function checkRetirements(retire: string[], sources: Source[]): void {
  const allowed = sources.map(({definition}) => `${OWNER_APP_ID}/${definition.name}`);
  if (retire.some((name) => !allowed.includes(name) || sources.some(({request}) => request.schema === name))) {
    fail("A saved retirement is outside the exact known app aliases.");
  }
}
function aliasSource(alias: ObjectValue, sources: Source[]): void {
  const fields = Array.isArray(alias.fields) ? alias.fields : [], mappings = object(alias.field_mappers);
  const kept = sources.find(({source}) => fields.length > 0 && Object.values(mappings).every((item) =>
    typeof item === "string" && item.startsWith(`${String(source.name)}.`)));
  if (!kept || alias.owner_app_id !== OWNER_APP_ID || alias.independent_fields === true ||
      alias.descriptive_name !== kept.source.descriptive_name || alias.schema_type !== kept.source.schema_type ||
      Object.keys(object(alias.transform_fields)).length || Object.keys(object(alias.alternate_keys)).length ||
      !same(Object.keys(mappings).sort(), [...fields].sort())) fail("An extra layout is not a complete alias of one kept record type.");
  const source = kept.source, prefix = `${String(source.name)}.`;
  const map = Object.fromEntries(Object.entries(mappings).map(([field, path]) => [field, String(path).slice(prefix.length)]));
  if (!same(Object.values(map).sort(), [...source.fields as string[]].sort()) ||
      Object.entries(map).some(([field, target]) => !same(object(alias.field_types)[field], object(source.field_types)[target])) ||
      map[String(object(alias.key).hash_field)] !== object(source.key).hash_field || object(alias.key).range_field != null) {
    fail("An alias changes field coverage, field types, or primary key roles.");
  }
  for (const [field, target] of Object.entries(map)) {
    const before = object(object(alias.field_data_classifications)[field]), after = object(object(source.field_data_classifications)[target]);
    if (!Number.isSafeInteger(before.sensitivity_level) || !Number.isSafeInteger(after.sensitivity_level) ||
        Number(before.sensitivity_level) > Number(after.sensitivity_level) ||
        String(before.data_domain).toLowerCase() !== String(after.data_domain).toLowerCase() ||
        tags(object(alias.field_classifications)[field]).filter((tag) => ["secret", "noindex"].includes(tag))
          .some((tag) => !tags(object(source.field_classifications)[target]).includes(tag))) fail("An alias loses protected field privacy.");
    const from = object(alias.field_molecule_uuids)[field], to = object(source.field_molecule_uuids)[target];
    if (from !== undefined && to !== undefined && (typeof from !== "string" || !from || from !== to)) {
      fail("An alias names a different stored molecule. No alias is retired.");
    }
  }
}
export async function aliasRetirements(client: LastDbClient, sources: Source[], capabilities: ObjectValue): Promise<string[]> {
  const directory = data(await client.nativeBatch.schemas());
  if (directory.ready !== true || !Array.isArray(directory.schemas)) fail("The schema directory is not ready.");
  const kept = sources.map(({request}) => request.schema);
  const allowed = sources.map(({definition}) => `${OWNER_APP_ID}/${definition.name}`);
  const extras = directory.schemas.map(object).filter((item) => !kept.includes(String(item.name)) &&
    (item.owner_app_id === OWNER_APP_ID || String(item.name).startsWith(`${OWNER_APP_ID}/`)));
  if (extras.some((item) => !allowed.includes(String(item.name)))) fail("An unknown app layout requires explicit preservation. No layout is retired.");
  const aliases = await Promise.all(extras.map((item) => schemaMetadata(client, String(item.name))));
  if (aliases.length && capabilities.app_schema_alias_retirement_v1 !== true) {
    fail("Alias retirement requires app_schema_alias_retirement_v1 and its atomic stored-molecule proof.");
  }
  aliases.forEach((alias, index) => {
    if (alias.name !== extras[index]!.name) fail("An alias address changed during metadata lookup.");
    aliasSource(alias, sources);
  });
  return aliases.map((alias) => String(alias.name)).sort();
}
