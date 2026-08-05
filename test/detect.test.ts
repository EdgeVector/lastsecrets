import { describe, expect, it } from "bun:test";

import { detectSecrets, hasHighConfidenceSecret, shannonEntropy } from "../src/detect.ts";

describe("secret detection", () => {
  it("flags provider token shapes as high confidence", () => {
    const text = "aws key AKIAIOSFODNN7EXAMPLE lives in the deploy notes";
    const detections = detectSecrets(text);
    expect(detections).toHaveLength(1);
    expect(detections[0]!.rule).toBe("aws-access-key-id");
    expect(detections[0]!.confidence).toBe("high");
    expect(hasHighConfidenceSecret(text)).toBe(true);
  });

  it("detects github and openai and slack tokens as high confidence", () => {
    const gh = detectSecrets("token ghp_" + "a".repeat(36));
    expect(gh[0]!.rule).toBe("github-token");
    expect(gh[0]!.confidence).toBe("high");

    const oa = detectSecrets("sk-proj-" + "B".repeat(40));
    expect(oa.some((d) => d.rule === "openai-key" && d.confidence === "high")).toBe(true);

    const slack = detectSecrets("xoxb-1234567890-abcdefghij");
    expect(slack[0]!.rule).toBe("slack-token");
  });

  it("detects a private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj\nabc123\n-----END RSA PRIVATE KEY-----";
    const detections = detectSecrets(`key is\n${pem}\nend`);
    expect(detections.some((d) => d.rule === "private-key-block")).toBe(true);
    expect(detections.find((d) => d.rule === "private-key-block")!.confidence).toBe("high");
  });

  it("treats bare secret assignments as uncertain, not high", () => {
    const detections = detectSecrets("password = hunter2placeholder");
    expect(detections).toHaveLength(1);
    expect(detections[0]!.confidence).toBe("uncertain");
    expect(detections[0]!.rule).toContain("assignment");
    expect(hasHighConfidenceSecret("password = hunter2placeholder")).toBe(false);
  });

  it("ignores placeholders, env refs, and already-migrated refs", () => {
    expect(detectSecrets("token = <redacted>")).toEqual([]);
    expect(detectSecrets("token = ${GITHUB_TOKEN}")).toEqual([]);
    expect(detectSecrets("token = $GITHUB_TOKEN")).toEqual([]);
    expect(detectSecrets("secret = changeme")).toEqual([]);
    expect(detectSecrets("secret = lastsecrets://schema-r2-dev")).toEqual([]);
    expect(detectSecrets("token = xxx")).toEqual([]);
  });

  it("ignores short values below the secret-length floor", () => {
    expect(detectSecrets("password = short")).toEqual([]);
  });

  it("does not double-count a high-confidence token also matching an assignment", () => {
    const text = "github_token = ghp_" + "z".repeat(36);
    const detections = detectSecrets(text);
    const high = detections.filter((d) => d.confidence === "high");
    expect(high).toHaveLength(1);
    // the assignment detection for the same value is suppressed
    expect(detections.filter((d) => d.value === "ghp_" + "z".repeat(36))).toHaveLength(1);
  });

  it("computes entropy (random > repeated)", () => {
    expect(shannonEntropy("aaaaaaaa")).toBeLessThan(shannonEntropy("a1b2c3d4"));
  });

  it("returns nothing for empty or clean text", () => {
    expect(detectSecrets("")).toEqual([]);
    expect(detectSecrets("just a normal note about the weather")).toEqual([]);
  });
});
