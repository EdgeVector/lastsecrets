import { describe, expect, it } from "bun:test";

import type { BrainClient, BrainRecord } from "../src/brain.ts";
import type { LastDbClient, QueryRow } from "../src/lastdb.ts";
import {
  applyMigration,
  parseMigrationReview,
  planMigration,
  renderMigrationLog,
  renderMigrationReview,
  type MigrationDeps,
  type ScanTarget,
} from "../src/migrate.ts";
import { getSecret } from "../src/storage.ts";

const SECRETS_CONFIG = { schemaHash: "secrets-schema" };
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

function newMemorySecrets(): LastDbClient {
  const rows = new Map<string, QueryRow>();
  return {
    async autoIdentity() {
      return { userHash: "user" };
    },
    async declareAppSchema() {
      return { canonical: SECRETS_CONFIG.schemaHash, schemaName: "lastsecrets/LastSecret" };
    },
    async createRecord({ keyHash, fields }) {
      rows.set(keyHash, { key: { hash: keyHash, range: null }, fields });
    },
    async updateRecord({ keyHash, fields }) {
      rows.set(keyHash, { key: { hash: keyHash, range: null }, fields });
    },
    async queryByKey({ keyHash }) {
      return rows.get(keyHash) ?? null;
    },
    async queryAll() {
      return Array.from(rows.values());
    },
  };
}

function newMemoryBrain(initial: BrainRecord[]): { client: BrainClient; records: Map<string, BrainRecord> } {
  const records = new Map<string, BrainRecord>();
  for (const r of initial) records.set(r.key, { ...r, fields: { ...r.fields } });
  const client: BrainClient = {
    async queryAll() {
      return Array.from(records.values()).map((r) => ({ ...r, fields: { ...r.fields } }));
    },
    async updateRecord(_schema, key, range, fields) {
      const current = records.get(key);
      records.set(key, { key, range, fields: { ...(current?.fields ?? {}), ...fields } });
    },
  };
  return { client, records };
}

const TARGETS: ScanTarget[] = [{ schema: "brain/Note", fields: ["body"] }];

describe("Brain → LastSecrets migration", () => {
  it("plans staged actions for high-confidence secrets and review for uncertain ones", async () => {
    const brain = newMemoryBrain([
      { key: "deploy-notes", range: null, fields: { body: `aws key ${AWS_KEY} used for uploads` } },
      { key: "misc-note", range: null, fields: { body: "password = maybeSecretValue123" } },
      { key: "clean-note", range: null, fields: { body: "no secrets here at all" } },
    ]);
    const deps: MigrationDeps = { brain: brain.client, secrets: newMemorySecrets(), secretsConfig: SECRETS_CONFIG };

    const plan = await planMigration(deps, TARGETS);
    expect(plan.scannedRecords).toBe(3);

    const staged = plan.actions.filter((a) => a.disposition === "stage");
    const review = plan.actions.filter((a) => a.disposition === "needs-review");
    expect(staged).toHaveLength(1);
    expect(staged[0]!.recordKey).toBe("deploy-notes");
    expect(staged[0]!.ref).toMatch(/^lastsecrets:\/\//);
    expect(review).toHaveLength(1);
    expect(review[0]!.recordKey).toBe("misc-note");

    // clean-note is recorded as intentionally untouched
    expect(plan.untouched.some((u) => u.recordKey === "clean-note")).toBe(true);

    // planning is read-only: brain body still contains the raw key
    expect(brain.records.get("deploy-notes")!.fields.body).toContain(AWS_KEY);
  });

  it("plan preview never contains the raw secret", async () => {
    const brain = newMemoryBrain([
      { key: "r", range: null, fields: { body: `key ${AWS_KEY}` } },
    ]);
    const deps: MigrationDeps = { brain: brain.client, secrets: newMemorySecrets(), secretsConfig: SECRETS_CONFIG };
    const plan = await planMigration(deps, TARGETS);
    const log = renderMigrationLog(plan, "plan");
    expect(log).not.toContain(AWS_KEY);
    expect(log).not.toContain("AKI");
    expect(log).not.toContain("PLE");
    expect(log).toContain("<redacted:");
    const review = renderMigrationReview(plan, new Date("2026-07-13T00:00:00Z"));
    expect(review).not.toContain(AWS_KEY);
    expect(review).not.toContain("AKI");
    expect(review).toContain("\"decision\": \"apply\"");
  });

  it("apply stores the secret and replaces the raw value with a locator", async () => {
    const brain = newMemoryBrain([
      { key: "deploy-notes", range: null, fields: { body: `aws key ${AWS_KEY} used for uploads` } },
      { key: "misc-note", range: null, fields: { body: "password = maybeSecretValue123" } },
    ]);
    const secrets = newMemorySecrets();
    const deps: MigrationDeps = { brain: brain.client, secrets, secretsConfig: SECRETS_CONFIG };

    const plan = await planMigration(deps, TARGETS);
    const staged = plan.actions.find((a) => a.disposition === "stage")!;
    const applied = await applyMigration(deps, plan, TARGETS);

    expect(applied.storedSecrets).toBe(1);
    expect(applied.updatedRecords).toBe(1);
    expect(applied.stagedButSkipped).toBe(1); // the uncertain one
    expect(applied.errors).toEqual([]);

    // raw value gone from the record, replaced by the ref
    const body = brain.records.get("deploy-notes")!.fields.body as string;
    expect(body).not.toContain(AWS_KEY);
    expect(body).toContain(staged.ref);

    // uncertain record left untouched
    expect(brain.records.get("misc-note")!.fields.body).toBe("password = maybeSecretValue123");

    // secret is retrievable through LastSecrets
    const stored = await getSecret(secrets, SECRETS_CONFIG, staged.slug);
    expect(stored.secretValue).toBe(AWS_KEY);
  });

  it("applies an uncertain detection only when the review contract explicitly approves it", async () => {
    const uncertainValue = "uncertainTokenValue123456";
    const brain = newMemoryBrain([
      { key: "manual-note", range: null, fields: { body: `token = ${uncertainValue}` } },
    ]);
    const secrets = newMemorySecrets();
    const deps: MigrationDeps = { brain: brain.client, secrets, secretsConfig: SECRETS_CONFIG };
    const plan = await planMigration(deps, TARGETS);

    const defaultApply = await applyMigration(deps, plan, TARGETS);
    expect(defaultApply.storedSecrets).toBe(0);
    expect(brain.records.get("manual-note")!.fields.body).toContain(uncertainValue);

    const review = parseMigrationReview(renderMigrationReview(plan));
    review.actions[0]!.decision = "apply";
    const approvedApply = await applyMigration(deps, plan, TARGETS, review);
    expect(approvedApply.storedSecrets).toBe(1);
    const body = brain.records.get("manual-note")!.fields.body as string;
    expect(body).not.toContain(uncertainValue);
    expect(body).toContain("lastsecrets://");
  });

  it("ignores already-migrated refs idempotently", async () => {
    const brain = newMemoryBrain([
      { key: "already", range: null, fields: { body: "token = lastsecrets://existing-token" } },
    ]);
    const deps: MigrationDeps = { brain: brain.client, secrets: newMemorySecrets(), secretsConfig: SECRETS_CONFIG };
    const plan = await planMigration(deps, TARGETS);
    const applied = await applyMigration(deps, plan, TARGETS);
    expect(plan.actions).toHaveLength(0);
    expect(applied.updatedRecords).toBe(0);
    expect(brain.records.get("already")!.fields.body).toBe("token = lastsecrets://existing-token");
  });

  it("does not write anything when there are no high-confidence secrets", async () => {
    const brain = newMemoryBrain([
      { key: "misc-note", range: null, fields: { body: "token = someUncertainThing123" } },
    ]);
    const deps: MigrationDeps = { brain: brain.client, secrets: newMemorySecrets(), secretsConfig: SECRETS_CONFIG };
    const plan = await planMigration(deps, TARGETS);
    const applied = await applyMigration(deps, plan, TARGETS);
    expect(applied.storedSecrets).toBe(0);
    expect(applied.updatedRecords).toBe(0);
    expect(applied.stagedButSkipped).toBe(1);
    expect(brain.records.get("misc-note")!.fields.body).toBe("token = someUncertainThing123");
  });

  it("assigns unique slugs when the same rule fires across records", async () => {
    const brain = newMemoryBrain([
      { key: "same", range: null, fields: { body: `a ${AWS_KEY} and also AKIAIOSFODNN7ANOTHER` } },
    ]);
    const deps: MigrationDeps = { brain: brain.client, secrets: newMemorySecrets(), secretsConfig: SECRETS_CONFIG };
    const plan = await planMigration(deps, TARGETS);
    const slugs = plan.actions.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("replaces distinct same-rule detections with their own refs", async () => {
    const otherAwsKey = "AKIAIOSFODNN7ANOTHER";
    const brain = newMemoryBrain([
      { key: "same", range: null, fields: { body: `a ${AWS_KEY} and b ${otherAwsKey}` } },
    ]);
    const secrets = newMemorySecrets();
    const deps: MigrationDeps = { brain: brain.client, secrets, secretsConfig: SECRETS_CONFIG };
    const plan = await planMigration(deps, TARGETS);
    const applied = await applyMigration(deps, plan, TARGETS);
    expect(applied.errors).toEqual([]);
    const body = brain.records.get("same")!.fields.body as string;
    expect(body).not.toContain(AWS_KEY);
    expect(body).not.toContain(otherAwsKey);
    for (const action of plan.actions) {
      expect(body).toContain(action.ref);
      const stored = await getSecret(secrets, SECRETS_CONFIG, action.slug);
      expect([AWS_KEY, otherAwsKey]).toContain(stored.secretValue);
    }
  });

  it("redacts raw values from partial-failure errors", async () => {
    const brain = newMemoryBrain([
      { key: "deploy-notes", range: null, fields: { body: `aws key ${AWS_KEY}` } },
    ]);
    const failingSecrets: LastDbClient = {
      ...newMemorySecrets(),
      async createRecord() {
        throw new Error(`backend rejected ${AWS_KEY}`);
      },
    };
    const deps: MigrationDeps = { brain: brain.client, secrets: failingSecrets, secretsConfig: SECRETS_CONFIG };
    const plan = await planMigration(deps, TARGETS);
    const applied = await applyMigration(deps, plan, TARGETS);
    expect(applied.storedSecrets).toBe(0);
    expect(applied.updatedRecords).toBe(0);
    expect(applied.errors).toHaveLength(1);
    expect(applied.errors[0]!.message).not.toContain(AWS_KEY);
    expect(renderMigrationLog(plan, "apply", applied)).not.toContain(AWS_KEY);
  });

  it("renders a log with staged, review, and untouched sections", async () => {
    const brain = newMemoryBrain([
      { key: "deploy", range: null, fields: { body: `key ${AWS_KEY}` } },
      { key: "maybe", range: null, fields: { body: "secret = uncertainCandidate99" } },
      { key: "clean", range: null, fields: { body: "nothing" } },
    ]);
    const deps: MigrationDeps = { brain: brain.client, secrets: newMemorySecrets(), secretsConfig: SECRETS_CONFIG };
    const plan = await planMigration(deps, TARGETS);
    const log = renderMigrationLog(plan, "plan");
    expect(log).toContain("## Staged replacements");
    expect(log).toContain("## Needs review");
    expect(log).toContain("## Intentionally left untouched");
    expect(log).toContain("SKIP record=clean");
  });
});
