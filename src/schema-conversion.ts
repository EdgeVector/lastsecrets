/** Explicit owner maintenance. This command never fetches secret values. */
import { readFileSync } from "node:fs";
import { configBytes, readConfig, writeConfig, type Config } from "./config.ts";
import { LastSecretsError, type LastDbClient } from "./lastdb.ts";
import { OWNER_APP_ID } from "./schema.ts";
import { aliasRetirements, checkMetadata, checkRetirements, conversionSources, targetConfig } from "./schema-conversion-rules.ts";
import { checkScope, data, fail, fence, object, readScope, receipt, removeScope, same, saveScope, sha, terminal,
  type ConversionScope, type ConversionReport } from "./conversion-scope.ts";

const ROUTE = "/api/db/alternate-keys";
async function status(client: LastDbClient): Promise<ConversionReport | undefined> {
  try { return receipt(await client.request(ROUTE, "POST", {action:"app_status"})); }
  catch (error) {
    if (error instanceof LastSecretsError && error.code === "app_conversion_absent") return undefined;
    throw error;
  }
}

export async function convertSchemaValues(client: LastDbClient, supplied: Config, path: string,
  options: {apply?: boolean; maintenance?: boolean; abort?: boolean}) {
  const initial = readFileSync(path, "utf8"), cfg = readConfig(path), scopePath = path + ".conversion.json";
  if (!same(cfg, supplied)) fail("The caller and saved config differ. Reopen the selected config before conversion.");
  if (options.abort && (!options.apply || !options.maintenance)) fail("Abort requires --apply --maintenance.");
  let {raw:scopeRaw, saved} = readScope(scopePath);
  const capabilities = object(data(await client.request("/api/version", "GET")).capabilities);
  if (capabilities.app_schema_conversion_v1 !== true) fail("Use a compatible release with app_schema_conversion_v1 before the engine upgrade.");
  let report = await status(client);
  const pending = report && !terminal(report) ? report : undefined;
  if (pending && !saved) fail("An active conversion has no matching durable local scope. The node stays unchanged.");
  const sources = await conversionSources(client, cfg, capabilities);
  const requests = sources.map(({request}) => request), target = targetConfig(cfg, sources);
  const sourceSha = sha(initial), targetSha = sha(configBytes(target));
  if (saved) {
    if (!same(saved.schemas, requests) || saved.target_config_sha256 !== targetSha ||
        ![saved.source_config_sha256, saved.target_config_sha256].includes(sourceSha)) {
      fail("The saved conversion request or config bytes differ. The node stays unchanged.");
    }
    checkMetadata(sources, saved, false);
    checkRetirements(saved.retire, sources);
  }
  if (pending) {
    checkScope(pending, saved!);
    if (saved!.retire.length && capabilities.app_schema_alias_retirement_v1 !== true) fail("The saved retirements require app_schema_alias_retirement_v1.");
  }
  if (saved && report?.phase === "aborted" && report.change_id === saved.change_id) {
    checkScope(report, saved);
    if (sourceSha !== saved.source_config_sha256) fail("The aborted conversion does not match the source config bytes.");
    if (options.apply && scopeRaw) removeScope(scopePath, scopeRaw);
    return {phase:"aborted", local_cleanup_required:!options.apply};
  }
  if (options.abort && !pending) {
    if (saved && !saved.change_id && saved.source_config_sha256 === sourceSha && scopeRaw) {
      removeScope(scopePath, scopeRaw);
      return {phase:"aborted", prepared_scope_only:true};
    }
    return fail("No unpublished conversion belongs to this saved scope.");
  }
  const allOwned = sources.every(({source}) => source.independent_fields === true);
  if (!pending && allOwned) {
    const directory = data(await client.nativeBatch.schemas());
    if (directory.ready !== true || !Array.isArray(directory.schemas)) fail("The schema directory is not ready.");
    if (directory.schemas.map(object).some((schema) =>
      (schema.owner_app_id === OWNER_APP_ID || String(schema.name).startsWith(`${OWNER_APP_ID}/`)) && schema.independent_fields !== true)) {
      fail("An old app layout remains outside the configured owned sources. Owner review is required before upgrade.");
    }
    if (saved) {
      if (report?.phase !== "complete" || saved.target_config_sha256 !== sourceSha) fail("The saved scope is incomplete.");
      checkScope(report, saved);
      if (report.selected_keys !== report.expected_selected_keys || report.processed_keys !== report.expected_keys) fail("The complete receipt has incomplete membership.");
    }
    if (options.apply) {
      writeConfig(target, path, initial, scopeRaw ?? undefined);
      if (saved && scopeRaw) removeScope(scopePath, scopeRaw);
    }
    return {phase:"complete", already_converted:true, converted_schemas:requests.map((item) => item.schema)};
  }
  if (!pending && sources.some(({source}) => source.independent_fields === true)) fail("The app mixes old and owned schema values. Owner review is required.");
  // A prepared scope must re-prove aliases. A running job uses only its exact saved retire list.
  const retire = pending ? saved!.retire : await aliasRetirements(client, sources, capabilities);
  if (!options.apply) return {phase:"plan", schemas:requests, retire};
  if (!options.maintenance) fail("Use --apply --maintenance for the explicit node request pause.");
  if (!pending) {
    const scope: ConversionScope = {source_config_sha256:sourceSha, target_config_sha256:targetSha,
      change_id:"", schemas:requests, retire, source_metadata:Object.fromEntries(sources.map(({request, metadata}) => [request.schema, metadata]))};
    if (saved && !same(saved, scope)) fail("A different saved conversion scope requires owner review.");
    scopeRaw = saveScope(scopePath, scope, scopeRaw);
    saved = scope;
    fence(path, scopeRaw, saved);
    report = receipt(await client.request(ROUTE, "POST", {action:"app_begin", schemas:requests, retire, maintenance:true}));
    checkScope(report, saved);
  }
  if (!saved || !report || !scopeRaw) return fail("The durable conversion scope is absent.");
  // A lost begin reply can bind only the exact full durable request, including for abort.
  if (!saved.change_id) {
    saved = {...saved, change_id:report.change_id};
    scopeRaw = saveScope(scopePath, saved, scopeRaw);
  }
  checkMetadata(await conversionSources(client, cfg, capabilities), saved, false);
  for (let page = 0; page < 100000; page++) {
    const raw = fence(path, scopeRaw, saved);
    checkScope(report, saved);
    let action: string;
    if (terminal(report)) {
      if ((report.phase === "complete" && sha(raw) !== saved.target_config_sha256) ||
          (report.phase === "aborted" && sha(raw) !== saved.source_config_sha256)) fail("The terminal receipt and config bytes differ.");
      removeScope(scopePath, scopeRaw);
      return report;
    }
    if (options.abort) {
      if (!["backfill", "verifying", "verified", "aborting"].includes(report.phase) || sha(raw) !== saved.source_config_sha256) {
        fail("A published conversion cannot abort.");
      }
      action = "app_abort";
    } else if (["backfill", "verifying"].includes(report.phase)) action = "app_page";
    else if (report.phase === "verified") action = "app_commit";
    else if (report.phase === "retiring") action = "app_cleanup";
    else if (report.phase === "ready") {
      if (report.selected_keys !== report.expected_selected_keys || report.processed_keys !== report.expected_keys) fail("The conversion membership is incomplete.");
      checkMetadata(await conversionSources(client, cfg, capabilities), saved, true);
      writeConfig(target, path, fence(path, scopeRaw, saved), scopeRaw);
      action = "app_finish";
    } else return fail(`Conversion ${report.change_id} remains in ${report.phase}. Resume or abort that saved scope.`);
    report = receipt(await client.request(ROUTE, "POST", {action, change_id:report.change_id}));
    checkScope(report, saved);
  }
  return fail("The page limit stopped the command. Resume the same saved conversion.");
}
