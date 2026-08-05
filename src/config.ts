import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeNodeUrl } from "./lastdb.ts";

export const CONFIG_VERSION = 1;

export type Config = {
  configVersion: number;
  nodeUrl: string;
  userHash: string;
  schemaHash: string;
  schemaName?: string;
  indexSchemaHash?: string;
  indexSchemaName?: string;
  nodeSocketPath?: string;
};

export class ConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

export function defaultConfigPath(): string {
  const override = process.env.LASTSECRETS_CONFIG;
  if (override && override.length > 0) return override;
  return join(homedir(), ".lastsecrets", "config.json");
}

export function readConfig(path = defaultConfigPath()): Config {
  if (!existsSync(path)) {
    throw new ConfigError(
      "config_missing",
      `Config not found at ${path}. Run \`lastsecrets init\` first.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(
      "config_invalid",
      `Config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return assertConfigShape(path, parsed);
}

export function writeConfig(config: Config, path = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function assertConfigShape(path: string, raw: unknown): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("config_invalid", `Config at ${path} must be an object.`);
  }
  const r = raw as Record<string, unknown>;
  for (const key of ["nodeUrl", "userHash", "schemaHash"] as const) {
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
      throw new ConfigError(
        "config_invalid",
        `Config at ${path} is missing non-empty field "${key}".`,
      );
    }
  }

  const config: Config = {
    configVersion: CONFIG_VERSION,
    // Heal retired TCP :9001 so stale configs keep working over the socket.
    nodeUrl: normalizeNodeUrl(r.nodeUrl as string),
    userHash: r.userHash as string,
    schemaHash: r.schemaHash as string,
  };
  if (typeof r.schemaName === "string" && r.schemaName.length > 0) {
    config.schemaName = r.schemaName;
  }
  if (typeof r.indexSchemaHash === "string" && r.indexSchemaHash.length > 0) {
    config.indexSchemaHash = r.indexSchemaHash;
  }
  if (typeof r.indexSchemaName === "string" && r.indexSchemaName.length > 0) {
    config.indexSchemaName = r.indexSchemaName;
  }
  if (typeof r.nodeSocketPath === "string" && r.nodeSocketPath.length > 0) {
    config.nodeSocketPath = r.nodeSocketPath;
  }
  return config;
}
