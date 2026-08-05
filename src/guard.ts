import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { detectSecrets, type Confidence } from "./detect.ts";

export type GuardFinding = {
  path: string;
  line: number;
  column: number;
  rule: string;
  confidence: Confidence;
  preview: string;
};

const SKIP_DIRS = new Set([
  ".git",
  ".lastsecrets",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
]);

const SKIP_FILES = new Set(["bun.lock"]);
const MAX_FILE_BYTES = 1024 * 1024;

export function guardPaths(paths: string[]): GuardFinding[] {
  const scanRoots = paths.length > 0 ? paths : ["."];
  const findings: GuardFinding[] = [];
  for (const root of scanRoots) {
    for (const file of walkFiles(root)) {
      const stat = statSync(file);
      if (stat.size > MAX_FILE_BYTES || SKIP_FILES.has(basename(file))) continue;
      const text = readTextFile(file);
      if (text === null) continue;
      findings.push(...scanText(file, text));
    }
  }
  return findings.sort((a, b) => {
    const byPath = a.path.localeCompare(b.path);
    if (byPath !== 0) return byPath;
    return a.line - b.line || a.column - b.column;
  });
}

export function scanText(path: string, text: string): GuardFinding[] {
  return detectSecrets(text).map((detection) => {
    const position = lineColumnAt(text, detection.index);
    return {
      path,
      line: position.line,
      column: position.column,
      rule: detection.rule,
      confidence: detection.confidence,
      preview: redactedLinePreview(text, detection.index, detection.value),
    };
  });
}

export function renderGuardReport(findings: GuardFinding[]): string {
  if (findings.length === 0) {
    return "lastsecrets guard: no likely raw secret persistence found\n";
  }
  const lines = [
    "lastsecrets guard: likely raw secret persistence found",
    "store raw values with `lastsecrets put --value-stdin`; persist only `lastsecrets://<slug>` locators outside point of use.",
  ];
  for (const finding of findings) {
    lines.push(
      `${finding.path}:${finding.line}:${finding.column} ${finding.confidence} ${finding.rule} ${finding.preview}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function* walkFiles(path: string): Generator<string> {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(basename(path))) return;
    for (const child of readdirSync(path)) {
      yield* walkFiles(join(path, child));
    }
    return;
  }
  if (stat.isFile()) yield path;
}

function readTextFile(path: string): string | null {
  const buffer = readFileSync(path);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function lineColumnAt(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastLineStart = 0;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastLineStart = i + 1;
    }
  }
  return { line, column: index - lastLineStart + 1 };
}

function redactedLinePreview(text: string, index: number, value: string): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const nextLine = text.indexOf("\n", index);
  const lineEnd = nextLine === -1 ? text.length : nextLine;
  return text.slice(lineStart, lineEnd).replace(value, "<redacted>").trim();
}
