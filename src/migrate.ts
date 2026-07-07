// Brain → LastSecrets migration engine.
//
// The deliverable is a REVIEWABLE, STAGED migration — not a mass rewrite of a
// live Brain. The flow is deliberately two-phase:
//
//   1. plan (default / --dry-run): scan candidate Brain records, classify every
//      detected secret, and emit a MigrationPlan + human-readable log. Nothing
//      is written. High-confidence detections become stageable actions; anything
//      uncertain is surfaced as `needs-review` and is never rewritten
//      automatically.
//
//   2. apply (--apply): execute only the approved/high-confidence actions —
//      store each secret through LastSecrets and update the owning Brain record
//      so the raw value is replaced by a `lastsecrets://` locator. Uncertain
//      detections are left untouched and recorded in the log as intentionally
//      skipped.
//
// This module is pure orchestration over injected clients so it can be unit
// tested with in-memory Brain/LastSecrets stubs, with no live node.

import type { BrainClient, BrainRecord } from "./brain.ts";
import { detectSecrets, type Confidence, type Detection } from "./detect.ts";
import type { LastDbClient } from "./lastdb.ts";
import { secretRef } from "./schema.ts";
import { putSecret, type SecretInput } from "./storage.ts";
import type { Config } from "./config.ts";

export type ScanTarget = {
  /** Schema name/hash to enumerate. */
  schema: string;
  /** Fields to request and scan for secret material. */
  fields: string[];
};

/** One planned unit of migration work for a single detected secret. */
export type PlannedAction = {
  recordKey: string;
  recordRange: string | null;
  /** Field on the record whose text contains the secret. */
  field: string;
  rule: string;
  confidence: Confidence;
  /** Slug the secret will be stored under in LastSecrets. */
  slug: string;
  /** `lastsecrets://<slug>` the raw value is replaced by. */
  ref: string;
  /**
   * "stage"       → high-confidence; will be applied under --apply.
   * "needs-review" → uncertain; recorded, never auto-applied.
   */
  disposition: "stage" | "needs-review";
  /** Redacted preview of the value for the log (never the raw secret). */
  preview: string;
};

/** A record left entirely untouched, with the reason (for the log). */
export type UntouchedRecord = {
  recordKey: string;
  reason: string;
};

export type MigrationPlan = {
  scannedRecords: number;
  actions: PlannedAction[];
  untouched: UntouchedRecord[];
};

export type ApplyResult = {
  storedSecrets: number;
  updatedRecords: number;
  stagedButSkipped: number; // needs-review actions never applied
  errors: { recordKey: string; slug: string; message: string }[];
};

/** How a slug is derived + metadata attached when a secret is stored. */
export type SlugStrategy = {
  slug: string;
  label: string;
  provider: string;
  purpose: string;
  environment: string;
};

export type MigrationDeps = {
  brain: BrainClient;
  secrets: LastDbClient;
  secretsConfig: Pick<Config, "schemaHash" | "schemaName">;
  /**
   * Derive the LastSecrets slug + metadata for a detection. Injected so callers
   * control naming; a default is provided by defaultSlugStrategy.
   */
  slugFor?: (record: BrainRecord, detection: Detection, field: string) => SlugStrategy;
};

const REDACT = "<redacted>";

/**
 * Build a migration plan by scanning the given targets. Read-only: performs no
 * writes to Brain or LastSecrets.
 */
export async function planMigration(deps: MigrationDeps, targets: ScanTarget[]): Promise<MigrationPlan> {
  const slugFor = deps.slugFor ?? defaultSlugStrategy;
  const actions: PlannedAction[] = [];
  const untouched: UntouchedRecord[] = [];
  const usedSlugs = new Set<string>();
  let scannedRecords = 0;

  for (const target of targets) {
    const records = await deps.brain.queryAll(target.schema, target.fields);
    for (const record of records) {
      scannedRecords++;
      let recordHadDetection = false;
      for (const field of target.fields) {
        const text = stringField(record.fields, field);
        if (!text) continue;
        const detections = detectSecrets(text);
        for (const detection of detections) {
          recordHadDetection = true;
          const strategy = uniqueSlug(slugFor(record, detection, field), usedSlugs);
          usedSlugs.add(strategy.slug);
          const ref = secretRef(strategy.slug);
          actions.push({
            recordKey: record.key,
            recordRange: record.range,
            field,
            rule: detection.rule,
            confidence: detection.confidence,
            slug: strategy.slug,
            ref,
            disposition: detection.confidence === "high" ? "stage" : "needs-review",
            preview: previewOf(detection.value),
          });
        }
      }
      if (!recordHadDetection) {
        untouched.push({ recordKey: record.key, reason: "no secret material detected" });
      }
    }
  }

  return { scannedRecords, actions, untouched };
}

/**
 * Apply a plan. Only actions with disposition "stage" are executed; each stores
 * its secret through LastSecrets, then replaces the raw value in the owning
 * Brain record with the `lastsecrets://` locator. "needs-review" actions are
 * counted and skipped — never rewritten without human review.
 *
 * Applying is idempotent per record: all replacements for a record are computed
 * against the freshly re-read field text and written in a single update.
 */
export async function applyMigration(
  deps: MigrationDeps,
  plan: MigrationPlan,
  targets: ScanTarget[],
): Promise<ApplyResult> {
  const result: ApplyResult = { storedSecrets: 0, updatedRecords: 0, stagedButSkipped: 0, errors: [] };
  const stageable = plan.actions.filter((a) => a.disposition === "stage");
  result.stagedButSkipped = plan.actions.length - stageable.length;
  if (stageable.length === 0) return result;

  // Re-read current record state so we rewrite against live text, not a snapshot.
  const schemaByRecord = new Map<string, string>();
  const recordsByKey = new Map<string, BrainRecord>();
  for (const target of targets) {
    const records = await deps.brain.queryAll(target.schema, target.fields);
    for (const record of records) {
      recordsByKey.set(record.key, record);
      schemaByRecord.set(record.key, target.schema);
    }
  }

  // Group actions by record so each record is updated at most once.
  const byRecord = new Map<string, PlannedAction[]>();
  for (const action of stageable) {
    const list = byRecord.get(action.recordKey) ?? [];
    list.push(action);
    byRecord.set(action.recordKey, list);
  }

  for (const [recordKey, recordActions] of byRecord) {
    const record = recordsByKey.get(recordKey);
    const schema = schemaByRecord.get(recordKey);
    if (!record || !schema) {
      result.errors.push({ recordKey, slug: "", message: "record no longer present in Brain; skipped" });
      continue;
    }

    // Store each secret first; only rewrite fields whose store succeeded.
    const storedByAction = new Map<PlannedAction, boolean>();
    for (const action of recordActions) {
      try {
        const text = stringField(record.fields, action.field);
        const rawValue = extractDetectionValue(text, action);
        if (rawValue == null) {
          result.errors.push({
            recordKey,
            slug: action.slug,
            message: `value for rule ${action.rule} no longer found in field ${action.field}; skipped`,
          });
          storedByAction.set(action, false);
          continue;
        }
        const input: SecretInput = buildSecretInput(action, rawValue);
        await putSecret(deps.secrets, deps.secretsConfig, input);
        result.storedSecrets++;
        storedByAction.set(action, true);
      } catch (err) {
        result.errors.push({
          recordKey,
          slug: action.slug,
          message: err instanceof Error ? err.message : String(err),
        });
        storedByAction.set(action, false);
      }
    }

    // Compute in-place field replacements for stored secrets only.
    const updatedFields: Record<string, unknown> = { ...record.fields };
    let changed = false;
    const byField = new Map<string, PlannedAction[]>();
    for (const action of recordActions) {
      if (!storedByAction.get(action)) continue;
      const list = byField.get(action.field) ?? [];
      list.push(action);
      byField.set(action.field, list);
    }
    for (const [field, fieldActions] of byField) {
      let text = stringField(record.fields, field);
      for (const action of fieldActions) {
        const rawValue = extractDetectionValue(text, action);
        if (rawValue == null) continue;
        text = text.split(rawValue).join(action.ref);
        changed = true;
      }
      updatedFields[field] = text;
    }

    if (changed) {
      try {
        await deps.brain.updateRecord(schema, record.key, record.range, updatedFields);
        result.updatedRecords++;
      } catch (err) {
        result.errors.push({
          recordKey,
          slug: "",
          message: `brain update failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  return result;
}

/** Default slug/metadata derivation: `<record>-<rule>-<n>` with generic metadata. */
export function defaultSlugStrategy(record: BrainRecord, detection: Detection, field: string): SlugStrategy {
  const base = slugify(`${record.key}-${detection.rule}`);
  return {
    slug: base,
    label: `Migrated from Brain record ${record.key} (${field})`,
    provider: providerFromRule(detection.rule),
    purpose: `migrated-from-brain-${slugify(record.key)}`,
    environment: "unknown",
  };
}

/** Render a plan as a stable, human-reviewable text migration log. */
export function renderMigrationLog(plan: MigrationPlan, mode: "plan" | "apply", applied?: ApplyResult): string {
  const lines: string[] = [];
  const staged = plan.actions.filter((a) => a.disposition === "stage");
  const review = plan.actions.filter((a) => a.disposition === "needs-review");
  lines.push(`# LastSecrets Brain migration log (${mode})`);
  lines.push("");
  lines.push(`scanned_records=${plan.scannedRecords}`);
  lines.push(`staged_actions=${staged.length}`);
  lines.push(`needs_review=${review.length}`);
  lines.push(`untouched_records=${plan.untouched.length}`);
  if (applied) {
    lines.push(`applied_stored_secrets=${applied.storedSecrets}`);
    lines.push(`applied_updated_records=${applied.updatedRecords}`);
    lines.push(`applied_skipped_needs_review=${applied.stagedButSkipped}`);
    lines.push(`applied_errors=${applied.errors.length}`);
  }
  lines.push("");

  lines.push("## Staged replacements (high confidence)");
  if (staged.length === 0) lines.push("(none)");
  for (const a of staged) {
    lines.push(
      `- STAGE record=${a.recordKey} field=${a.field} rule=${a.rule} -> ${a.ref} value=${a.preview}`,
    );
  }
  lines.push("");

  lines.push("## Needs review (uncertain — NOT rewritten)");
  if (review.length === 0) lines.push("(none)");
  for (const a of review) {
    lines.push(
      `- REVIEW record=${a.recordKey} field=${a.field} rule=${a.rule} candidate_ref=${a.ref} value=${a.preview}`,
    );
  }
  lines.push("");

  lines.push("## Intentionally left untouched");
  if (plan.untouched.length === 0) lines.push("(none)");
  for (const u of plan.untouched) {
    lines.push(`- SKIP record=${u.recordKey} reason=${u.reason}`);
  }

  if (applied && applied.errors.length > 0) {
    lines.push("");
    lines.push("## Apply errors");
    for (const e of applied.errors) {
      lines.push(`- ERROR record=${e.recordKey} slug=${e.slug} ${e.message}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// --- internal helpers -------------------------------------------------------

function buildSecretInput(action: PlannedAction, value: string): SecretInput {
  return {
    slug: action.slug,
    label: `Migrated: ${action.recordKey} (${action.field})`,
    provider: providerFromRule(action.rule),
    purpose: `migrated-from-brain-${slugify(action.recordKey)}`,
    environment: "unknown",
    value,
  };
}

/**
 * Recover the exact raw substring for an action from current field text. We
 * re-detect rather than trusting a stored raw value so the migration never
 * carries the plaintext secret around in the plan.
 */
function extractDetectionValue(text: string, action: PlannedAction): string | null {
  const detections = detectSecrets(text);
  for (const d of detections) {
    if (d.rule === action.rule) return d.value;
  }
  return null;
}

function providerFromRule(rule: string): string {
  if (rule.startsWith("aws")) return "aws";
  if (rule.startsWith("github")) return "github";
  if (rule.startsWith("slack")) return "slack";
  if (rule.startsWith("stripe")) return "stripe";
  if (rule.startsWith("openai")) return "openai";
  if (rule.startsWith("anthropic")) return "anthropic";
  if (rule.startsWith("google")) return "google";
  return "unknown";
}

function previewOf(value: string): string {
  if (value.length <= 6) return REDACT;
  return `${value.slice(0, 3)}${REDACT}${value.slice(-2)}`;
}

function stringField(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value === "string") return value;
  return "";
}

function slugify(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "record";
}

function uniqueSlug(strategy: SlugStrategy, used: Set<string>): SlugStrategy {
  if (!used.has(strategy.slug)) return strategy;
  let n = 2;
  let candidate = `${strategy.slug}-${n}`;
  while (used.has(candidate)) {
    n++;
    candidate = `${strategy.slug}-${n}`;
  }
  return { ...strategy, slug: candidate };
}
