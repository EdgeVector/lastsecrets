import { describe, expect, it } from "bun:test";

import { lastSecretSchema, searchableFields, secretRef } from "../src/schema.ts";

describe("LastSecrets schema", () => {
  it("keeps secret_value out of the searchable field allowlist", () => {
    expect(searchableFields(lastSecretSchema.schema)).toEqual([
      "environment",
      "label",
      "provider",
      "purpose",
    ]);
  });

  it("classifies secret_value as secret and no_index", () => {
    expect(lastSecretSchema.schema.field_classifications.secret_value).toContain("secret");
    expect(lastSecretSchema.schema.field_classifications.secret_value).toContain("no_index");
    expect(lastSecretSchema.schema.field_classifications.secret_value).not.toContain("word");
  });

  it("uses non-empty field classifications to avoid legacy index-all behavior", () => {
    expect(Object.keys(lastSecretSchema.schema.field_classifications).length).toBeGreaterThan(0);
  });

  it("formats stable lastsecrets references", () => {
    expect(secretRef("schema-resolver-r2-prod")).toBe(
      "lastsecrets://schema-resolver-r2-prod",
    );
    expect(() => secretRef("../bad")).toThrow();
  });
});
