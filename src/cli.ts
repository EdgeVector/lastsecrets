#!/usr/bin/env bun

import { canonicalSchema } from "./canonical-vocabulary.ts";
import vocabulary from "./canonical-fields.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import { LAST_SECRET_INDEX_SCHEMA, LAST_SECRET_SCHEMA, lastSecretSchema, secretRef } from "./schema.ts";
import { ConfigError, defaultConfigPath, readConfig, writeConfig, type Config } from "./config.ts";
import {
  defaultNodeUrl,
  installedFieldAliases,
  newLastDbClient,
  resolveSocketPath,
} from "./lastdb.ts";
import { captureSentryException, initSentry } from "./observability/sentry.ts";
import {
  buildAdminSecretsSlice,
  deleteSecrets,
  formatMetadata,
  getSecret,
  listSecrets,
  loadStorageConfig,
  putSecret,
  searchSecrets,
} from "./storage.ts";
import { guardPaths, renderGuardReport } from "./guard.ts";

type Io = {
  stdout: Pick<typeof process.stdout, "write">;
  stderr: Pick<typeof process.stderr, "write">;
  stdinText: () => Promise<string>;
};

const defaultIo: Io = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdinText: () => Bun.stdin.text(),
};

type Deps = { newClient: typeof newLastDbClient };
const defaultDeps: Deps = { newClient: newLastDbClient };

export async function run(
  argv = process.argv.slice(2),
  io: Io = defaultIo,
  cliDeps: Deps = defaultDeps,
): Promise<number> {
  const [command, arg, ...rest] = argv;
  let deleteCommandStarted = false;
  try {
    if (command === "schema-json") {
      io.stdout.write(`${JSON.stringify({...lastSecretSchema, schema:canonicalSchema(lastSecretSchema.schema)}, null, 2)}\n`);
      return 0;
    }
    if (command === "vocabulary-json") {
      io.stdout.write(`${JSON.stringify(vocabulary.fields, null, 2)}\n`);
      return 0;
    }
    if (command === "ref" && arg) {
      io.stdout.write(`${secretRef(arg)}\n`);
      return 0;
    }
    if (command === "init") {
      const opts = parseOptions([arg, ...rest].filter((v): v is string => v !== undefined));
      const nodeUrl = opts.nodeUrl ?? defaultNodeUrl();
      const socketPath = resolveSocketPath(opts.socketPath);
      const configPath = opts.config ?? defaultConfigPath();
      let existing: Config | null = null;
      try { existing = readConfig(configPath); } catch (error) {
        if (!(error instanceof ConfigError) || error.code !== "config_missing") throw error;
      }
      // Local config only. The installer places the schemas. This command does not contact the node.
      writeConfig(
        {
          configVersion: 1,
          nodeUrl,
          userHash: existing?.userHash ?? "local",
          schemaHash: LAST_SECRET_SCHEMA,
          schemaName: LAST_SECRET_SCHEMA,
          indexSchemaHash: LAST_SECRET_INDEX_SCHEMA,
          indexSchemaName: LAST_SECRET_INDEX_SCHEMA,
          nodeSocketPath: socketPath,
          schemaFieldAliases: installedFieldAliases(),
        },
        configPath,
      );
      io.stdout.write(`initialized LastSecrets config at ${configPath}\n`);
      io.stdout.write(`schema=${LAST_SECRET_SCHEMA}\n`);
      io.stdout.write(`index-schema=${LAST_SECRET_INDEX_SCHEMA}\n`);
      return 0;
    }

    if (command === "delete") {
      const { slugs, configPath } = parseDeleteArgs([arg, ...rest].filter((v): v is string => v !== undefined));
      const config = loadStorageConfig(configPath);
      const client = cliDeps.newClient({
        socketPath: config.nodeSocketPath, schemaFieldAliases:config.schemaFieldAliases,
      });
      // This path never declares schemas, grants access, rewrites config, or retries.
      deleteCommandStarted = true;
      const receipt = await deleteSecrets(client, config, slugs);
      io.stdout.write(`${JSON.stringify(receipt)}\n`);
      return receipt.ok ? 0 : 1;
    }

    if (command === "put" && arg) {
      const opts = parseOptions(rest);
      if (!opts.valueStdin) throw new Error("put requires --value-stdin");
      const value = await io.stdinText();
      const input = {
        slug: arg,
        label: requireOpt(opts, "label"),
        provider: requireOpt(opts, "provider"),
        purpose: requireOpt(opts, "purpose"),
        environment: requireOpt(opts, "env"),
        value,
      };
      const meta = await withStorage(cliDeps, opts.config, (client, config) =>
        putSecret(client, config, input),
      );
      io.stdout.write(`${formatMetadata(meta)}\n`);
      return 0;
    }

    if (command === "get" && arg) {
      const opts = parseOptions(rest);
      const secret = await withStorage(cliDeps, opts.config, (client, config) =>
        getSecret(client, config, arg),
      );
      io.stdout.write(secret.secretValue);
      if (!secret.secretValue.endsWith("\n")) io.stdout.write("\n");
      return 0;
    }

    if (command === "list") {
      const opts = parseOptions([arg, ...rest].filter((v): v is string => v !== undefined));
      const secrets = await withStorage(cliDeps, opts.config, (client, config) =>
        listSecrets(client, config),
      );
      for (const secret of secrets) {
        io.stdout.write(`${formatMetadata(secret)}\n`);
      }
      return 0;
    }

    if (command === "search" && arg) {
      const opts = parseOptions(rest);
      const found = await withStorage(cliDeps, opts.config, (client, config) =>
        searchSecrets(client, config, arg),
      );
      for (const secret of found) {
        io.stdout.write(`${formatMetadata(secret)}\n`);
      }
      return 0;
    }

    if (command === "admin-slice") {
      const opts = parseOptions([arg, ...rest].filter((v): v is string => v !== undefined));
      const listed = await withStorage(cliDeps, opts.config, (client, config) =>
        listSecrets(client, config),
      );
      const slice = buildAdminSecretsSlice(listed);
      io.stdout.write(`${JSON.stringify(slice, null, 2)}\n`);
      return 0;
    }

    if (command === "guard") {
      const paths = [arg, ...rest].filter((v): v is string => v !== undefined);
      const findings = guardPaths(paths);
      io.stdout.write(renderGuardReport(findings));
      return findings.length === 0 ? 0 : 1;
    }

    io.stderr.write(`${usage()}\n`);
    return 2;
  } catch (err) {
    if (command === "delete") {
      // Config and argument errors can contain caller bytes; do not send them to telemetry.
      io.stdout.write(`${JSON.stringify({
        schema: "lastsecrets.delete.v1", ok: false,
        code: deleteCommandStarted ? "delete_outcome_unconfirmed" : "delete_refused_before_request",
        delete_outcome: deleteCommandStarted ? "unknown" : "not_sent",
        metadata_cleanup: deleteCommandStarted ? "unknown" : "not_attempted", post_read: "not_completed",
        full_record_absence_verified: false, secret_value_tip_absence_verified: false,
      })}\n`);
      return 1;
    }
    await captureSentryException(err, {
      entrypoint: "cli",
      command: command ?? "none",
      top_level: "true",
    });
    io.stderr.write(`lastsecrets: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export type CliSentryBootstrap =
  | { initialized: true }
  | { initialized: false; reason: "no_dsn" | "unresolved_locator" | "init_failed" };

// Telemetry setup is never the command. Every path here returns a reason; none
// of them throws. `lastsecrets get <slug>` used to exit 1 with empty stdout for
// every caller whose environment carried OBS_SENTRY_DSN, because this function
// threw before `run()` started and the top-level catch turned a telemetry
// problem into a failed secret lookup.
export async function initCliSentry(
  env: Record<string, string | undefined> = process.env,
  stderr: Pick<typeof process.stderr, "write"> = process.stderr,
): Promise<CliSentryBootstrap> {
  const dsn = env.OBS_SENTRY_DSN?.trim();
  if (!dsn) {
    return { initialized: false, reason: "no_dsn" };
  }

  // An unresolved `lastsecrets://` locator is a reference to a DSN, not a DSN.
  // Initializing on it cannot work, and the resolver that would expand it is
  // this same CLI. Say so once and carry on.
  if (dsn.startsWith("lastsecrets://")) {
    stderr.write(
      "lastsecrets: OBS_SENTRY_DSN is an unresolved lastsecrets:// locator; skipping Sentry init\n",
    );
    return { initialized: false, reason: "unresolved_locator" };
  }

  try {
    await initSentry({
      service: "lastsecrets-cli",
      env: {
        ...env,
        OBS_SENTRY_RELEASE: env.OBS_SENTRY_RELEASE ?? `lastsecrets@${pkg.version}`,
      },
    });
    return { initialized: true };
  } catch (err) {
    stderr.write(
      `lastsecrets: Sentry init skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { initialized: false, reason: "init_failed" };
  }
}

/** Ordinary requests use the saved addresses and never declare or retry a write. */
async function withStorage<T>(
  deps: Deps,
  configPath: string | undefined,
  fn: (client: ReturnType<typeof newLastDbClient>, config: Config) => Promise<T>,
): Promise<T> {
  const config = loadStorageConfig(configPath);
  const client = deps.newClient({
    socketPath: config.nodeSocketPath,
    schemaFieldAliases:config.schemaFieldAliases,
  });
  return fn(client, config);
}

type Options = {
  config?: string;
  nodeUrl?: string;
  socketPath?: string;
  label?: string;
  provider?: string;
  purpose?: string;
  env?: string;
  valueStdin?: boolean;
};

function parseOptions(args: string[]): Options {
  const opts: Options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--value-stdin") {
      opts.valueStdin = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    if (key === "config") opts.config = value;
    else if (key === "node-url") opts.nodeUrl = value;
    else if (key === "socket") opts.socketPath = value;
    else if (key === "label") opts.label = value;
    else if (key === "provider") opts.provider = value;
    else if (key === "purpose") opts.purpose = value;
    else if (key === "env") opts.env = value;
    else throw new Error(`unknown option: --${key}`);
  }
  return opts;
}

function parseDeleteArgs(args: string[]): { slugs: string[]; configPath?: string } {
  const slugs: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--config") {
      const value = args[++i];
      if (configPath !== undefined || !value || value.startsWith("--")) throw new Error("invalid delete config option");
      configPath = value;
    } else if (arg.startsWith("--")) {
      throw new Error("unsupported delete option");
    } else {
      slugs.push(arg);
    }
  }
  return { slugs, configPath };
}

function requireOpt(opts: Options, key: "label" | "provider" | "purpose" | "env"): string {
  const value = opts[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function usage(): string {
  return [
    "usage: lastsecrets init [--config PATH] [--node-url URL] [--socket PATH]",
    "       lastsecrets schema-json",
    "       lastsecrets vocabulary-json",
    "       lastsecrets put <slug> --label TEXT --provider TEXT --purpose TEXT --env TEXT --value-stdin",
    "       lastsecrets get <slug>",
    "       lastsecrets delete <slug> [<slug> ...] [--config PATH]",
    "       lastsecrets ref <slug>",
    "       lastsecrets list",
    "       lastsecrets search <term>",
    "       lastsecrets admin-slice",
    "       lastsecrets guard [PATH...]",
    "",
    "init     — write the local config with the exact schema names. The installer places the schemas.",
    "admin-slice — emit metadata-only JSON for the admin delivery path.",
    "delete   — delete exact local slugs and repair metadata; emit a value-free JSON receipt.",
  ].join("\n");
}

if (import.meta.main) {
  try {
    await initCliSentry();
    const code = await run();
    process.exit(code);
  } catch (err) {
    await captureSentryException(err, {
      entrypoint: "cli",
      top_level: "true",
    });
    console.error(`lastsecrets: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
