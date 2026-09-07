#!/usr/bin/env bun

import pkg from "../package.json" with { type: "json" };
import { OWNER_APP_ID, lastSecretIndexSchema, lastSecretSchema, secretRef } from "./schema.ts";
import { defaultConfigPath, readConfig, writeConfig, type Config } from "./config.ts";
import {
  defaultNodeUrl,
  newLastDbClient,
  normalizeNodeUrl,
  resolveSocketPath,
} from "./lastdb.ts";
import { captureSentryException, initSentry } from "./observability/sentry.ts";
import {
  buildAdminSecretsSlice,
  formatMetadata,
  getSecret,
  listSecrets,
  loadStorageConfig,
  putSecret,
  searchSecrets,
} from "./storage.ts";
import { newBrainClient } from "./brain.ts";
import {
  applyMigration,
  planMigration,
  renderMigrationLog,
  type ScanTarget,
} from "./migrate.ts";
import { guardPaths, renderGuardReport } from "./guard.ts";
import { writeFileSync } from "node:fs";

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

export async function run(argv = process.argv.slice(2), io: Io = defaultIo): Promise<number> {
  const [command, arg, ...rest] = argv;
  try {
    if (command === "schema-json") {
      io.stdout.write(`${JSON.stringify(lastSecretSchema, null, 2)}\n`);
      return 0;
    }
    if (command === "ref" && arg) {
      io.stdout.write(`${secretRef(arg)}\n`);
      return 0;
    }
    if (command === "init") {
      const opts = parseOptions([arg, ...rest].filter((v): v is string => v !== undefined));
      const nodeUrl = normalizeNodeUrl(opts.nodeUrl ?? defaultNodeUrl());
      const socketPath = resolveSocketPath(opts.socketPath);
      const preflight = newLastDbClient({ nodeUrl, socketPath });
      const { userHash } = await preflight.autoIdentity();
      const client = newLastDbClient({ nodeUrl, socketPath, userHash });
      // Mini owns resolve/registration and must return Schema Service catalog
      // identities; private visibility is not a local-only schema mode.
      const { canonical, schemaName } = await client.declareAppSchema(
        OWNER_APP_ID,
        lastSecretSchema.schema,
      );
      const { canonical: indexCanonical, schemaName: indexSchemaName } =
        await client.declareAppSchema(OWNER_APP_ID, lastSecretIndexSchema.schema);
      const configPath = opts.config ?? defaultConfigPath();
      writeConfig(
        {
          configVersion: 1,
          nodeUrl,
          userHash,
          schemaHash: canonical,
          schemaName,
          indexSchemaHash: indexCanonical,
          indexSchemaName,
          nodeSocketPath: socketPath,
        },
        configPath,
      );
      io.stdout.write(`initialized LastSecrets config at ${configPath}\n`);
      io.stdout.write(`schema=${canonical}\n`);
      io.stdout.write(`index-schema=${indexCanonical}\n`);
      io.stdout.write(`schemas registered with Schema Service; run \`lastsecrets publish\` to add distribution governance.\n`);
      return 0;
    }

    // Add distribution governance and verify the already-required Schema
    // Service registrations so other people can install/depend on LastSecrets.
    // Requires Mini with register-for-distribution routes
    // (fold main after PR #469) and a reachable schema service.
    if (command === "publish") {
      const opts = parseOptions([arg, ...rest].filter((v): v is string => v !== undefined));
      const nodeUrl = opts.nodeUrl ?? defaultNodeUrl();
      const socketPath = resolveSocketPath(opts.socketPath);
      const preflight = newLastDbClient({ nodeUrl, socketPath });
      const { userHash } = await preflight.autoIdentity();
      const client = newLastDbClient({ nodeUrl, socketPath, userHash });

      const registered = await client.registerForDistribution(OWNER_APP_ID, [
        lastSecretSchema.schema,
        lastSecretIndexSchema.schema,
      ]);
      for (const item of registered.items) {
        const err = item.error ? ` error=${item.error}` : "";
        io.stdout.write(
          `register ${item.schema_name || "?"} status=${item.status} hash=${item.identity_hash || "-"}${err}\n`,
        );
      }
      if (!registered.ok) {
        throw new Error(
          "register-for-distribution failed for one or more schemas (Schema Service reachable? Mini on fold main?)",
        );
      }

      const identities = registered.items
        .map((i) => i.identity_hash)
        .filter((h) => h.length > 0);
      const verified = await client.verifyDistributionReady(OWNER_APP_ID, identities);
      for (const item of verified.items) {
        const err = item.error ? ` error=${item.error}` : "";
        io.stdout.write(`verify ${item.identity} status=${item.status}${err}\n`);
      }
      if (!verified.ready) {
        throw new Error(
          "verify-distribution-ready failed: not all schemas are present on Schema Service",
        );
      }

      // Keep local config pinned to the registered identities when possible.
      const primary = registered.items.find((i) => i.schema_name.endsWith("/LastSecret"));
      const indexItem = registered.items.find((i) => i.schema_name.endsWith("/LastSecretIndex"));
      if (primary?.identity_hash) {
        const configPath = opts.config ?? defaultConfigPath();
        let existing: Config | null = null;
        try {
          existing = readConfig(configPath);
        } catch {
          existing = null;
        }
        writeConfig(
          {
            configVersion: 1,
            nodeUrl: existing?.nodeUrl ?? nodeUrl,
            userHash: existing?.userHash ?? userHash,
            schemaHash: primary.identity_hash,
            schemaName: primary.schema_name || "lastsecrets/LastSecret",
            indexSchemaHash: indexItem?.identity_hash ?? existing?.indexSchemaHash,
            indexSchemaName:
              indexItem?.schema_name || existing?.indexSchemaName || "lastsecrets/LastSecretIndex",
            nodeSocketPath: existing?.nodeSocketPath ?? socketPath,
          },
          configPath,
        );
        io.stdout.write(`updated config at ${configPath}\n`);
      }

      io.stdout.write(
        `published: LastSecrets schemas registered on Schema Service (ready for others to install/depend).\n`,
      );
      return 0;
    }

    if (command === "put" && arg) {
      const opts = parseOptions(rest);
      if (!opts.valueStdin) throw new Error("put requires --value-stdin");
      const { client, config } = await prepareStorage(opts.config);
      const value = await io.stdinText();
      const meta = await putSecret(client, config, {
        slug: arg,
        label: requireOpt(opts, "label"),
        provider: requireOpt(opts, "provider"),
        purpose: requireOpt(opts, "purpose"),
        environment: requireOpt(opts, "env"),
        value,
      });
      io.stdout.write(`${formatMetadata(meta)}\n`);
      return 0;
    }

    if (command === "get" && arg) {
      const opts = parseOptions(rest);
      const { client, config } = await prepareStorage(opts.config);
      const secret = await getSecret(client, config, arg);
      io.stdout.write(secret.secretValue);
      if (!secret.secretValue.endsWith("\n")) io.stdout.write("\n");
      return 0;
    }

    if (command === "list") {
      const opts = parseOptions([arg, ...rest].filter((v): v is string => v !== undefined));
      const { client, config } = await prepareStorage(opts.config);
      for (const secret of await listSecrets(client, config)) {
        io.stdout.write(`${formatMetadata(secret)}\n`);
      }
      return 0;
    }

    if (command === "search" && arg) {
      const opts = parseOptions(rest);
      const { client, config } = await prepareStorage(opts.config);
      for (const secret of await searchSecrets(client, config, arg)) {
        io.stdout.write(`${formatMetadata(secret)}\n`);
      }
      return 0;
    }

    if (command === "admin-slice") {
      const opts = parseOptions([arg, ...rest].filter((v): v is string => v !== undefined));
      const { client, config } = await prepareStorage(opts.config);
      const slice = buildAdminSecretsSlice(await listSecrets(client, config));
      io.stdout.write(`${JSON.stringify(slice, null, 2)}\n`);
      return 0;
    }

    if (command === "migrate") {
      const opts = parseOptions([arg, ...rest].filter((v): v is string => v !== undefined));
      if (!opts.schema) throw new Error("migrate requires --schema NAME (repeatable via comma)");
      if (opts.fields.length === 0) {
        throw new Error("migrate requires --fields FIELD[,FIELD...] to scan");
      }
      const rawConfig = loadStorageConfig(opts.config);
      const secrets = newLastDbClient({
        nodeUrl: rawConfig.nodeUrl,
        socketPath: rawConfig.nodeSocketPath,
        userHash: rawConfig.userHash,
      });
      const config = await declareStorageSchemas(secrets, rawConfig);
      const brain = newBrainClient({
        nodeUrl: config.nodeUrl,
        socketPath: config.nodeSocketPath,
        userHash: config.userHash,
      });
      const targets: ScanTarget[] = opts.schema
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((schema) => ({ schema, fields: opts.fields }));
      const deps = { brain, secrets, secretsConfig: config };
      const plan = await planMigration(deps, targets);

      const mode = opts.apply ? "apply" : "plan";
      let applied;
      if (opts.apply) {
        applied = await applyMigration(deps, plan, targets);
      }
      const log = renderMigrationLog(plan, mode, applied);
      if (opts.log) {
        writeFileSync(opts.log, log, { encoding: "utf8", mode: 0o600 });
        io.stdout.write(`migration log written to ${opts.log}\n`);
      } else {
        io.stdout.write(`${log}\n`);
      }
      if (applied && applied.errors.length > 0) return 1;
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

async function prepareStorage(configPath?: string): Promise<{
  client: ReturnType<typeof newLastDbClient>;
  config: Config;
}> {
  const config = loadStorageConfig(configPath);
  const client = newLastDbClient({
    nodeUrl: config.nodeUrl,
    socketPath: config.nodeSocketPath,
    userHash: config.userHash,
  });
  return { client, config: await declareStorageSchemas(client, config) };
}

async function declareStorageSchemas(
  client: ReturnType<typeof newLastDbClient>,
  config: Config,
): Promise<Config> {
  const declared = await client.declareAppSchema(OWNER_APP_ID, lastSecretSchema.schema);
  const declaredIndex = await client.declareAppSchema(OWNER_APP_ID, lastSecretIndexSchema.schema);
  return {
    ...config,
    schemaHash: declared.canonical,
    schemaName: declared.schemaName,
    indexSchemaHash: declaredIndex.canonical,
    indexSchemaName: declaredIndex.schemaName,
  };
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
  schema?: string;
  fields: string[];
  apply?: boolean;
  log?: string;
};

function parseOptions(args: string[]): Options {
  const opts: Options = { fields: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--value-stdin") {
      opts.valueStdin = true;
      continue;
    }
    if (arg === "--apply") {
      opts.apply = true;
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
    else if (key === "schema") opts.schema = value;
    else if (key === "fields") {
      opts.fields = value
        .split(",")
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
    } else if (key === "log") opts.log = value;
    else throw new Error(`unknown option: --${key}`);
  }
  return opts;
}

function requireOpt(opts: Options, key: "label" | "provider" | "purpose" | "env"): string {
  const value = opts[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function usage(): string {
  return [
    "usage: lastsecrets init [--config PATH] [--node-url URL] [--socket PATH]",
    "       lastsecrets publish [--config PATH] [--node-url URL] [--socket PATH]",
    "       lastsecrets schema-json",
    "       lastsecrets put <slug> --label TEXT --provider TEXT --purpose TEXT --env TEXT --value-stdin",
    "       lastsecrets get <slug>",
    "       lastsecrets ref <slug>",
    "       lastsecrets list",
    "       lastsecrets search <term>",
    "       lastsecrets admin-slice",
    "       lastsecrets migrate --schema NAME[,NAME] --fields FIELD[,FIELD] [--apply] [--log PATH]",
    "       lastsecrets guard [PATH...]",
    "",
    "init     — resolve/register schemas through Mini and pin catalog identities.",
    "publish  — add distribution governance and verify Schema Service identities.",
    "admin-slice — emit metadata-only JSON for the admin delivery path.",
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
