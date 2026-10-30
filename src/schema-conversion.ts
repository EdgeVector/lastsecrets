/** Explicit owner maintenance. This command never fetches secret values. */
import { canonicalSchema, profilesFor } from "./canonical-vocabulary.ts";
import { readConfig, writeConfig, type Config } from "./config.ts";
import { LastSecretsError, type LastDbClient } from "./lastdb.ts";
import { OWNER_APP_ID, lastSecretSchema, lastSecretIndexSchema } from "./schema.ts";

type ObjectValue = Record<string, unknown>;
type Report = {
  change_id: string; phase: string; durable: true;
  converted_schemas: string[]; retired_schemas: string[];
  selected_keys: number; expected_selected_keys: number;
  schemas: Array<{schema: string; expected_identity: string}>;
};
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value)
  ? value as ObjectValue : {};
const data = (value: unknown): ObjectValue => object(object(value).data ?? value);
function fail(message: string): never { throw new Error(`LastSecrets schema conversion: ${message}`); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value)
    .filter(([,item]) => item !== undefined).sort(([a],[b]) => a.localeCompare(b))
    .map(([key,item]) => JSON.stringify(key) + ":" + stable(item)).join(",") + "}";
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const terminal = (report: Report) => ["complete", "aborted"].includes(report.phase);
function receipt(value: unknown): Report {
  const report = object(data(value).app_schema_conversion);
  const phases = ["backfill", "verifying", "verified", "retiring", "ready", "aborting", "complete", "aborted"];
  if (report.durable !== true || typeof report.change_id !== "string" || !report.change_id ||
      typeof report.phase !== "string" || !phases.includes(report.phase) ||
      !Array.isArray(report.converted_schemas) || !Array.isArray(report.retired_schemas) ||
      report.retired_schemas.some((name) => typeof name !== "string" || !name) ||
      !Array.isArray(report.schemas) || !Number.isSafeInteger(report.selected_keys) ||
      !Number.isSafeInteger(report.expected_selected_keys) || Number(report.selected_keys) < 0 ||
      Number(report.selected_keys) > Number(report.expected_selected_keys)) {
    fail("the node did not return a valid durable receipt. No next phase or config write follows this reply.");
  }
  return report as Report;
}
async function status(client: LastDbClient): Promise<Report | undefined> {
  try { return receipt(await client.request("/api/db/alternate-keys", "POST", {action:"app_status"})); }
  catch (error) {
    if (error instanceof LastSecretsError && error.code === "node_http_404" &&
        error.message.includes("app conversion is absent")) return undefined;
    throw error;
  }
}

export async function convertSchemaValues(client: LastDbClient, cfg: Config, configPath: string,
  options: {apply?: boolean; maintenance?: boolean; abort?: boolean}) {
  const version = data(await client.request("/api/version", "GET"));
  if (object(version.capabilities).app_schema_conversion_v1 !== true) {
    fail("use a compatible release with app_schema_conversion_v1 before the engine upgrade.");
  }
  const entries = [
    {pin:cfg.schemaHash, definition:lastSecretSchema.schema, member:"secret_value"},
    {pin:cfg.indexSchemaHash, definition:lastSecretIndexSchema.schema, member:"payload_json"},
  ];
  if (entries.some(({pin}) => !pin || !/^[a-f0-9]{64}$/.test(pin)) ||
      new Set(entries.map(({pin}) => pin)).size !== 2) fail("two distinct saved definition identities are required.");
  let report = await status(client);
  const pending = report && !terminal(report) ? report : undefined;
  const checkScope = (current: Report) => {
    if (current.schemas.length !== entries.length || current.converted_schemas.length !== entries.length ||
        new Set(current.converted_schemas).size !== entries.length ||
        new Set(current.schemas.map((item) => item?.schema)).size !== entries.length || current.schemas.some((item) =>
          typeof item?.schema !== "string" || !current.converted_schemas.includes(item.schema)) ||
        entries.some(({pin}) => current.schemas.filter((item) => item.expected_identity === pin).length !== 1)) {
      fail("another conversion is active, or its saved identities differ. This command leaves it unchanged.");
    }
  };
  if (pending) checkScope(pending);
  const step = async (action: string) => {
    const changeId = report!.change_id;
    const next = receipt(await client.request("/api/db/alternate-keys", "POST", {action, change_id:changeId}));
    if (next.change_id !== changeId) fail("the conversion identity changed. Resume only after owner review.");
    checkScope(next);
    report = next;
    return next;
  };
  if (options.abort) {
    if (!options.apply || !options.maintenance || !pending) fail("abort requires an active conversion and --apply --maintenance.");
    for (let page=0; page<100000; page++) {
      await step("app_abort");
      if (report!.phase === "aborted") return report!;
    }
    fail("the abort page limit stopped the command. Resume the same abort.");
  }
  const sources = await Promise.all(entries.map(async(entry) => {
    const address = pending?.schemas.find((item) => item.expected_identity === entry.pin)?.schema ?? entry.pin!;
    const response = data(await client.request(`/api/schema/${encodeURIComponent(address)}`, "GET"));
    const source = object(response.schema ?? response);
    const canonical = Boolean(cfg.schemaFieldAliases?.[entry.pin!]);
    const definition = canonical ? canonicalSchema(entry.definition) : entry.definition;
    if (source.identity_hash !== entry.pin || source.owner_app_id !== OWNER_APP_ID ||
        source.descriptive_name !== definition.descriptive_name || typeof source.name !== "string" ||
        source.schema_type !== definition.schema_type || !Array.isArray(source.fields) ||
        !same([...source.fields].sort(), [...definition.fields].sort()) ||
        !same([object(source.key).hash_field, object(source.key).range_field ?? null], [definition.key.hash_field, null]) ||
        !same(source.field_types, definition.field_types) || !same(source.field_descriptions, definition.field_descriptions) ||
        Object.keys(object(source.field_mappers)).length || Object.keys(object(source.transform_fields)).length) {
      fail("an installed schema differs from the saved app definition. Review it before conversion.");
    }
    const member = cfg.schemaFieldAliases?.[entry.pin!]?.[entry.member] ?? entry.member;
    return {entry, source, canonical, request:{schema:source.name, expected_identity:entry.pin,
      alternate_keys:{}, membership:{kind:"field_exists", field:member}}};
  }));
  const names = sources.map(({source}) => source.name as string);
  if (new Set(names).size !== entries.length) fail("two app schemas resolve to the same runtime address.");
  if (!pending && sources.every(({source}) => source.independent_fields === true)) {
    return {phase:"complete", already_converted:true, converted_schemas:names};
  }
  if (!pending && sources.some(({source}) => source.independent_fields === true)) fail("the installed schema models differ.");
  let retire = pending?.retired_schemas ?? [];
  if (!pending) {
    const catalog = data(await client.nativeBatch.schemas());
    if (catalog.ready !== true || !Array.isArray(catalog.schemas)) fail("the schema directory is not ready.");
    const aliases = catalog.schemas.map(object).filter((item) => sources.some(({entry}) =>
      item.name === `${OWNER_APP_ID}/${entry.definition.name}`) && !names.includes(String(item.name)));
    retire = await Promise.all(aliases.map(async(alias) => {
      const response = data(await client.request(`/api/schema/${encodeURIComponent(String(alias.name))}`, "GET"));
      const schema = object(response.schema ?? response);
      const mappings = Object.values(object(schema.field_mappers));
      if (schema.owner_app_id !== OWNER_APP_ID || schema.independent_fields === true || !mappings.length ||
          mappings.some((value) => typeof value !== "string" || !names.includes(value.split(".")[0]!))) {
        fail("a local alias has values outside the kept sources. Review it before conversion.");
      }
      return String(schema.name);
    }));
  }
  if (!options.apply) return {phase:"plan", schemas:sources.map(({request}) => request), retire};
  if (!options.maintenance) fail("use --apply --maintenance to authorize the request pause and conversion.");
  if (!pending) {
    report = receipt(await client.request("/api/db/alternate-keys", "POST", {action:"app_begin",
      schemas:sources.map(({request}) => request), retire, maintenance:true}));
    checkScope(report);
  }
  try {
    for (let page=0; ["backfill", "verifying"].includes(report!.phase) && page<100000; page++) await step("app_page");
    if (report!.phase === "verified") await step("app_commit");
    for (let page=0; report!.phase === "retiring" && page<100000; page++) await step("app_cleanup");
    if (report!.phase !== "ready" || report!.selected_keys !== report!.expected_selected_keys) {
      fail("the conversion is incomplete. Resume the same command.");
    }
    const current = await Promise.all(names.map(async(name) => {
      const response = data(await client.request(`/api/schema/${encodeURIComponent(name)}`, "GET"));
      return object(response.schema ?? response);
    }));
    if (current.some((schema, position) => schema.independent_fields !== true ||
        schema.identity_hash !== entries[position]!.pin || Object.keys(object(schema.alternate_keys)).length)) {
      fail("the published schema ownership or identity differs. The config stays unchanged.");
    }
    if (!same(readConfig(configPath), cfg)) fail("the config changed. Review it before resume.");
    const fieldProfiles = Object.assign({}, cfg.schemaFieldAliases, ...sources.filter(({canonical}) => canonical)
      .map(({entry,source}) => profilesFor(entry.definition, [entry.pin!, String(source.name)])));
    writeConfig({...cfg, schemaName:names[0], indexSchemaName:names[1],
      schemaFieldAliases:Object.keys(fieldProfiles).length ? fieldProfiles : undefined}, configPath);
    const finished = await step("app_finish");
    if (finished.phase !== "complete") fail("the final receipt is incomplete. Resume the same command.");
    return finished;
  } catch {
    fail(`conversion ${report!.change_id} remains in ${report!.phase}. Resume this command; use --abort only before publication.`);
  }
}
