/** Durable command authority. No secret record bytes enter this file. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ObjectValue = Record<string, unknown>;
export type ConversionRequest = {
  schema: string; expected_identity: string; alternate_keys: Record<string, never>;
  membership: {kind: "field_exists"; field: string};
};
export type ConversionReport = {
  change_id: string; phase: string; durable: true;
  converted_schemas: string[]; retired_schemas: string[]; schemas: ConversionRequest[];
  selected_keys: number; expected_selected_keys: number; processed_keys: number; expected_keys: number;
};
export type ConversionScope = {
  source_config_sha256: string; target_config_sha256: string; change_id: string;
  schemas: ConversionRequest[]; retire: string[];
  source_metadata: Record<string, {definition_sha256: string; mappers_sha256: string}>;
};
export const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value)
  ? value as ObjectValue : {};
export const data = (value: unknown): ObjectValue => object(object(value).data ?? value);
export function fail(message: string): never { throw new Error(`LastSecrets schema conversion: ${message}`); }
export function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value)
    .filter(([,item]) => item !== undefined).sort(([a],[b]) => a.localeCompare(b))
    .map(([key,item]) => JSON.stringify(key) + ":" + stable(item)).join(",") + "}";
  return JSON.stringify(value);
}
export const same = (a: unknown, b: unknown) => stable(a) === stable(b);
export const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const identity = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const terminal = (report: ConversionReport) => ["complete", "aborted"].includes(report.phase);
const names = (value: unknown): value is string[] => Array.isArray(value)
  && value.every((name) => typeof name === "string" && name.length > 0) && new Set(value).size === value.length;
function requests(value: unknown): value is ConversionRequest[] {
  return Array.isArray(value) && value.length === 2 && names(value.map((item) => object(item).schema))
    && value.every((item) => {
      const request = object(item), member = object(request.membership);
      return same(Object.keys(request).sort(), ["alternate_keys", "expected_identity", "membership", "schema"])
        && identity(request.expected_identity) && same(request.alternate_keys, {})
        && same(Object.keys(member).sort(), ["field", "kind"]) && member.kind === "field_exists"
        && typeof member.field === "string" && Boolean(member.field);
    });
}
export function receipt(value: unknown): ConversionReport {
  const report = object(data(value).app_schema_conversion);
  if (report.durable !== true || typeof report.change_id !== "string" || !report.change_id ||
      !["backfill", "verifying", "verified", "retiring", "ready", "aborting", "complete", "aborted"].includes(String(report.phase)) ||
      !names(report.converted_schemas) || !names(report.retired_schemas) || !requests(report.schemas) ||
      !same([...report.converted_schemas].sort(), report.schemas.map((item) => item.schema).sort()) ||
      !["selected_keys", "expected_selected_keys", "processed_keys", "expected_keys"].every((key) =>
        Number.isSafeInteger(report[key]) && Number(report[key]) >= 0) ||
      Number(report.selected_keys) > Number(report.expected_selected_keys) || Number(report.processed_keys) > Number(report.expected_keys)) {
    fail("The node did not return a valid durable receipt. No next phase follows.");
  }
  return report as ConversionReport;
}
export function checkScope(report: ConversionReport, scope: ConversionScope): void {
  if ((scope.change_id && scope.change_id !== report.change_id) || !same(report.schemas, scope.schemas) ||
      !same([...report.converted_schemas].sort(), scope.schemas.map((item) => item.schema).sort()) ||
      !same([...report.retired_schemas].sort(), [...scope.retire].sort())) {
    fail("Another conversion owns this node, or its request, membership, retirement, or change identity differs.");
  }
}
export function readScope(path: string): {raw: string | null; saved?: ConversionScope} {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (raw === null) return {raw};
  let scope: ConversionScope;
  try { scope = JSON.parse(raw) as ConversionScope; } catch { return fail("The saved scope is unreadable. Owner review is required."); }
  const metadata = object(scope?.source_metadata);
  if (!identity(scope?.source_config_sha256) || !identity(scope?.target_config_sha256) ||
      typeof scope?.change_id !== "string" || !requests(scope?.schemas) || !names(scope?.retire) ||
      !same(Object.keys(metadata).sort(), scope.schemas.map((item) => item.schema).sort()) ||
      Object.values(metadata).some((value) => !identity(object(value).definition_sha256) || !identity(object(value).mappers_sha256))) {
    fail("The saved scope is invalid. Owner review is required.");
  }
  return {raw, saved: scope};
}
function barrier(path: string): void {
  const file = openSync(dirname(path), "r");
  try { fsyncSync(file); } finally { closeSync(file); }
}
export function saveScope(path: string, scope: ConversionScope, previous: string | null): string {
  const current = () => existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current() !== previous) fail("The saved scope changed.");
  const raw = JSON.stringify(scope, null, 2) + "\n", temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, raw, {encoding: "utf8", mode: 0o600, flag: "wx"});
    const file = openSync(temporary, "r");
    try { fsyncSync(file); } finally { closeSync(file); }
    if (current() !== previous) fail("The saved scope changed before publication.");
    if (previous === null) linkSync(temporary, path); else renameSync(temporary, path);
    barrier(path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return raw;
}
export function removeScope(path: string, expected: string): void {
  if (readFileSync(path, "utf8") !== expected) fail("The saved scope changed before completion.");
  unlinkSync(path);
  barrier(path);
}
export function fence(path: string, rawScope: string, scope: ConversionScope): string {
  const raw = readFileSync(path, "utf8");
  if (readFileSync(path + ".conversion.json", "utf8") !== rawScope ||
      ![scope.source_config_sha256, scope.target_config_sha256].includes(sha(raw))) {
    fail("The config or saved scope changed. No next phase follows.");
  }
  return raw;
}
