// Secret detection + classification for the Brain → LastSecrets migration.
//
// This module is intentionally pure and dependency-free: it takes the text of a
// Brain record and returns candidate secret detections with a confidence level.
// The migration never rewrites a record on a low-confidence ("uncertain")
// detection — those are surfaced for human review instead. Keeping the
// heuristics here, separate from any LastDB/Brain I/O, is what makes the
// classification reviewable and unit-testable.

export type Confidence = "high" | "uncertain";

export type Detection = {
  /** The exact raw secret substring found in the source text. */
  value: string;
  /** How the detection was made, for the migration log and review. */
  rule: string;
  /** high = safe to stage an automatic replacement; uncertain = review only. */
  confidence: Confidence;
  /** Byte offset of `value` within the scanned text. */
  index: number;
};

// Values that look secret-shaped but are placeholders / redactions / examples.
// A detection whose value matches one of these is dropped, not surfaced.
const PLACEHOLDER_VALUES = new Set([
  "<redacted>",
  "redacted",
  "xxx",
  "xxxx",
  "changeme",
  "example",
  "your-token-here",
  "your_token_here",
  "todo",
  "tbd",
  "none",
  "null",
]);

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^x{3,}$/i,
  /^\*{3,}$/,
  /^\.{3,}$/,
  /^<[^>]+>$/, // <something>
  /^\$\{[^}]+\}$/, // ${ENV_VAR}
  /^\$[A-Z_][A-Z0-9_]*$/, // $ENV_VAR
  /^env:/i,
  /^lastsecrets:\/\//i, // already migrated
];

// High-confidence provider token shapes. Matching one of these is strong enough
// to stage an automatic replacement (still logged, still overridable).
const HIGH_CONFIDENCE_TOKEN_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { rule: "github-pat-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { rule: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: "stripe-key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { rule: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g },
  { rule: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9-]{20,}\b/g },
  { rule: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

// Keys that, when assigned a value, indicate the value is a secret. Matching one
// of these produces an *uncertain* detection (the assignment could be a doc
// example, a schema field name, or a placeholder) — surfaced for review, never
// auto-rewritten.
const SECRET_ASSIGNMENT_RE =
  /\b(secret|token|password|passwd|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|bearer|credential)s?\b\s*[:=]\s*["'`]?([^\s"'`,;]{8,})["'`]?/gi;

// Minimum length for a value to be considered a plausible secret at all.
const MIN_SECRET_LENGTH = 8;

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return true;
  if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return true;
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

/**
 * Shannon entropy per character. High-entropy assignment values (random-looking
 * tokens) are more likely to be real secrets than dictionary words.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Scan a block of text for candidate secrets. Returns detections sorted by
 * position, de-duplicated by (value,index). High-confidence provider shapes and
 * private-key blocks are marked `high`; generic secret-shaped assignments are
 * marked `uncertain` and must be reviewed before any rewrite.
 */
export function detectSecrets(text: string): Detection[] {
  if (!text) return [];
  const found: Detection[] = [];
  const seen = new Set<string>();

  const push = (value: string, rule: string, confidence: Confidence, index: number) => {
    if (isPlaceholder(value)) return;
    const dedupeKey = `${index}:${value}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    found.push({ value, rule, confidence, index });
  };

  for (const { rule, re } of HIGH_CONFIDENCE_TOKEN_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      push(m[0], rule, "high", m.index);
      if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
    }
  }

  SECRET_ASSIGNMENT_RE.lastIndex = 0;
  let a: RegExpExecArray | null;
  while ((a = SECRET_ASSIGNMENT_RE.exec(text)) !== null) {
    const value = a[2] ?? "";
    if (!value) continue;
    // If the value already matched a high-confidence provider pattern at this
    // spot, skip the weaker assignment detection to avoid double-counting.
    const valueIndex = text.indexOf(value, a.index);
    const alreadyHigh = found.some(
      (d) => d.confidence === "high" && d.value === value,
    );
    if (alreadyHigh) continue;
    // Entropy gate: a high-entropy assignment value is a stronger signal, but
    // still only "uncertain" — an assignment key can appear in documentation,
    // schema definitions, or example snippets. Everything from a bare
    // `key = value` stays review-only.
    push(value, `${a[1].toLowerCase()}-assignment`, "uncertain", valueIndex);
  }

  return found.sort((x, y) => x.index - y.index);
}

/** True if the text contains any high-confidence secret. */
export function hasHighConfidenceSecret(text: string): boolean {
  return detectSecrets(text).some((d) => d.confidence === "high");
}
