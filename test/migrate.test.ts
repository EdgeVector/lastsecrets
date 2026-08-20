import { describe, expect, it } from "bun:test";

import type { BrainClient, BrainRecord } from "../src/brain.ts";
import type { LastDbClient, QueryRow } from "../src/lastdb.ts";
import {
  applyMigration,
  planMigration,
  renderMigrationLog,
  type MigrationDeps,
  type ScanTarget,
} from "../src/migrate.ts";
import { getSecret } from "../src/storage.ts";

const SECRETS_CONFIG = { schemaHash: "secrets-schema", indexSchemaHash: "secrets-index-schema" };
const AWS_KEY = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");
const SECOND_AWS_KEY = ["AK", "IA", "IOSFODNN7ANOTHER"].join("");

function newMemorySecrets(): LastDbClient {
  const rows = new Map<string, QueryRow>();
  return {
    async autoIdentity() {
      return { userHash: "user" };
    },
    async declareAppSchema() {
      return { canonical: SECRETS_CONFIG.schemaHash, schemaName: "lastsecrets/LastSecret" };
    },
    async registerForDistribution() {
      return {
        app_id: "lastsecrets",
        ok: true,
        items: [
          {
            app_id: "lastsecrets",
            schema_name: "lastsecrets/LastSecret",
            identity_hash: SECRETS_CONFIG.schemaHash,
            status: "registered" as const,
          },
        ],
      };
    },
    async verifyDistributionReady() {
      return {
        app_id: "lastsecrets",
        ready: true,
        items: [{ identity: SECRETS_CONFIG.schemaHash, status: "present" as const }],
      };
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
    async listKeys() {
      return Array.from(records.values(), (r) => ({ hash: r.key, range: r.range }));
    },
    async queryByKey(_schema, key) {
      const record = records.get(key.hash);
      return record && record.range === key.range
        ? { ...record, fields: { ...record.fields } }
        : null;
    },
    async updateRecord(_schema, key, range, fields) {
      records.set(key, { key, range, fields: { ...fields } });
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

  it("walks live listed keys and point-gets each record", async () => {
    const records = new Map<string, BrainRecord>([
      ["one", { key: "one", range: null, fields: { body: "clean one" } }],
      ["two", { key: "two", range: null, fields: { body: "clean two" } }],
      ["three", { key: "three", range: null, fields: { body: "clean three" } }],
    ]);
    const calls: string[] = [];
    const brain: BrainClient = {
      async listKeys() {
        calls.push("list");
        return Array.from(records.values(), (record) => ({ hash: record.key, range: record.range }));
      },
      async queryByKey(_schema, key) {
        calls.push(`get:${key.hash}`);
        const record = records.get(key.hash);
        return record ? { ...record, fields: { ...record.fields } } : null;
      },
      async updateRecord() {},
    };
    const deps: MigrationDeps = { brain, secrets: newMemorySecrets(), secretsConfig: SECRETS_CONFIG };

    expect((await planMigration(deps, TARGETS)).scannedRecords).toBe(3);
    expect(calls).toEqual(["list", "get:one", "get:two", "get:three"]);

    records.delete("two");
    calls.length = 0;
    expect((await planMigration(deps, TARGETS)).scannedRecords).toBe(2);
    expect(calls).toEqual(["list", "get:one", "get:three"]);
  });

  it("plan preview never contains the raw secret", async () => {
    const brain = newMemoryBrain([
      { key: "r", range: null, fields: { body: `key ${AWS_KEY}` } },
    ]);
    const deps: MigrationDeps = { brain: brain.client, secrets: newMemorySecrets(), secretsConfig: SECRETS_CONFIG };
    const plan = await planMigration(deps, TARGETS);
    const log = renderMigrationLog(plan, "plan");
    expect(log).not.toContain(AWS_KEY);
    expect(log).toContain("<redacted>");
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
      { key: "same", range: null, fields: { body: `a ${AWS_KEY} and also ${SECOND_AWS_KEY}` } },
    ]);
    const deps: MigrationDeps = { brain: brain.client, secrets: newMemorySecrets(), secretsConfig: SECRETS_CONFIG };
    const plan = await planMigration(deps, TARGETS);
    const slugs = plan.actions.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
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
