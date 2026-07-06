#!/usr/bin/env bun

import { lastSecretSchema, secretRef } from "./schema.ts";
import { defaultConfigPath, writeConfig } from "./config.ts";
import { defaultNodeUrl, newLastDbClient, resolveSocketPath } from "./lastdb.ts";
import {
  formatMetadata,
  getSecret,
  listSecrets,
  loadStorageConfig,
  putSecret,
  searchSecrets,
} from "./storage.ts";

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
      const nodeUrl = opts.nodeUrl ?? defaultNodeUrl();
      const socketPath = resolveSocketPath(opts.socketPath);
      const preflight = newLastDbClient({ nodeUrl, socketPath });
      const { userHash } = await preflight.autoIdentity();
      const client = newLastDbClient({ nodeUrl, socketPath, userHash });
      const { canonical, schemaName } = await client.declareAppSchema(
        "lastsecrets",
        lastSecretSchema.schema,
      );
      const configPath = opts.config ?? defaultConfigPath();
      writeConfig(
        {
          configVersion: 1,
          nodeUrl,
          userHash,
          schemaHash: canonical,
          schemaName,
          nodeSocketPath: socketPath,
        },
        configPath,
      );
      io.stdout.write(`initialized LastSecrets config at ${configPath}\n`);
      io.stdout.write(`schema=${canonical}\n`);
      return 0;
    }

    if (command === "put" && arg) {
      const opts = parseOptions(rest);
      if (!opts.valueStdin) throw new Error("put requires --value-stdin");
      const config = loadStorageConfig(opts.config);
      const client = newLastDbClient({
        nodeUrl: config.nodeUrl,
        socketPath: config.nodeSocketPath,
        userHash: config.userHash,
      });
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
      const config = loadStorageConfig(opts.config);
      const client = newLastDbClient({
        nodeUrl: config.nodeUrl,
        socketPath: config.nodeSocketPath,
        userHash: config.userHash,
      });
      const secret = await getSecret(client, config, arg);
      io.stdout.write(secret.secretValue);
      if (!secret.secretValue.endsWith("\n")) io.stdout.write("\n");
      return 0;
    }

    if (command === "list") {
      const opts = parseOptions([arg, ...rest].filter((v): v is string => v !== undefined));
      const config = loadStorageConfig(opts.config);
      const client = newLastDbClient({
        nodeUrl: config.nodeUrl,
        socketPath: config.nodeSocketPath,
        userHash: config.userHash,
      });
      for (const secret of await listSecrets(client, config)) {
        io.stdout.write(`${formatMetadata(secret)}\n`);
      }
      return 0;
    }

    if (command === "search" && arg) {
      const opts = parseOptions(rest);
      const config = loadStorageConfig(opts.config);
      const client = newLastDbClient({
        nodeUrl: config.nodeUrl,
        socketPath: config.nodeSocketPath,
        userHash: config.userHash,
      });
      for (const secret of await searchSecrets(client, config, arg)) {
        io.stdout.write(`${formatMetadata(secret)}\n`);
      }
      return 0;
    }

    io.stderr.write(`${usage()}\n`);
    return 2;
  } catch (err) {
    io.stderr.write(`lastsecrets: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
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

function requireOpt(opts: Options, key: "label" | "provider" | "purpose" | "env"): string {
  const value = opts[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function usage(): string {
  return [
    "usage: lastsecrets init [--config PATH] [--node-url URL] [--socket PATH]",
    "       lastsecrets schema-json",
    "       lastsecrets put <slug> --label TEXT --provider TEXT --purpose TEXT --env TEXT --value-stdin",
    "       lastsecrets get <slug>",
    "       lastsecrets ref <slug>",
    "       lastsecrets list",
    "       lastsecrets search <term>",
  ].join("\n");
}

if (import.meta.main) {
  const code = await run();
  process.exit(code);
}
