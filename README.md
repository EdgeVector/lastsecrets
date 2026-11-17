# LastSecrets

LastSecrets stores local secrets in LastDB while keeping raw secret values out of automatic search indexes.

The durable contract is:

- raw values live in LastDB records owned by the LastSecrets app;
- Brain and other apps store `lastsecrets://...` references, not raw values;
- secret value fields use normal value types plus `secret` / `no_index` field classifications;
- searchable metadata is opt-in through explicit `word` classification;
- no embeddings or generated indexes are committed to Git.

## Install (public)

```sh
git clone https://github.com/EdgeVector/lastsecrets.git
cd lastsecrets && bun install && bun link
# after lastdb is running:
lastsecrets init
```

Public download surface: `https://github.com/EdgeVector/lastsecrets`. EdgeVector
contributor review is on GitHub pull requests.

## Initial Schema

The secret records and metadata summaries use separate schemas that own their values.
Canonical field definitions stay reusable. They do not share record values.
These are separate record types, so this change adds no alternate key.
The installer places both schemas from `lastdb-app.json`.
The app addresses them by the exact names `lastsecrets/LastSecret` and `lastsecrets/LastSecretIndex`.
`init` writes the local config. It does not contact LastDB and it does not declare schemas.

The initial schema contract is defined in `src/schema.ts`.

`secret_value` is deliberately a normal object field with secret/no-index classifications. Secrecy is a field policy, not a distinct primitive value type.

## CLI

Initialize the local LastDB-backed config:

```sh
lastsecrets init
```

Socket resolution order: `--socket`, `LASTSECRETS_SOCKET_PATH`, `LASTDB_SOCKET_PATH`, the config `nodeSocketPath`, then `$LASTDB_HOME/data/folddb.sock`.

When `LASTDB_APP_DATA` is set, the config file is `$LASTDB_APP_DATA/config.json`. `LASTSECRETS_CONFIG` still wins. Otherwise the config file is `~/.lastsecrets/config.json`.

Store a secret from stdin:

```sh
printf '%s' "$TOKEN" | lastsecrets put schema-r2-dev \
  --label "Schema resolver R2 dev token" \
  --provider cloudflare \
  --purpose schema-resolver-pack-upload \
  --env dev \
  --value-stdin
```

Retrieve only when the raw value is needed:

```sh
lastsecrets get schema-r2-dev
```

Reference secrets from Brain, Kanban, docs, or scripts with stable refs:

```sh
lastsecrets ref schema-r2-dev
```

`lastsecrets list` and `lastsecrets search <term>` return metadata only and always print `value=<redacted>`.

### Metadata index rows

The `LastSecretIndex` schema keeps the metadata list in 33 rows of one schema, key, and field (`src/index-rows.ts`):

- `__all__` is the root row. An earlier release kept every entry there.
- `__bucket_00__` to `__bucket_31__` are the bucket rows. The first byte of sha256(slug), modulo 32, selects the bucket of a slug.

A format 7 home refuses a record above 64 KiB, with all fields and stamps. One row for every secret reaches that cap at a few hundred secrets.

- `list`, `search`, and `admin-slice` read the 33 rows in one batch read by key. A bucket entry wins over a root entry for the same slug.
- `put` reads the root row and the bucket row with the secret. It writes the entry to the bucket row. Then it removes the entry from the root row if the root row holds it.
- `put` refuses before any write when the bucket `payload_json`, as stored in the record, would be above 48 KiB (49,152 bytes). A bucket holds about 130 entries at that size.
- New entries never go into the root row. The root row only becomes smaller.

An existing home needs no conversion. A home with all entries in `__all__` is a valid state of these rows.

CAUTION: The description of the index key field still says that `__all__` names the complete local list. Only a new schema publication can change that text. The root row is the complete list only on a home that this release has not written.

Delete one or more exact local slugs after their task ends:

```sh
lastsecrets delete temporary-dev-invite temporary-dev-api-key
```

The command accepts 1–63 distinct slugs and an optional `--config PATH`.
It uses the same configured schema names as get and put.
A saved config must already name `lastsecrets/LastSecret` and `lastsecrets/LastSecretIndex`. A 64-hex schema id does not resolve on the app socket.
It reads those keys through `POST /v1/read`. An empty record list means the key is absent. A per-item error means the read was not confirmed.
LastSecrets keeps the selected metadata and record revision for deletion and emits a receipt containing only references and outcomes.
Each read sends at most 64 keys in one list. Larger reads use parallel lists.
A malformed, incomplete, or out-of-scope read stops that path before a write.
It sends one `POST /v1/write` delete list for the named records that exist, each conditioned on the revision from the read.
An absent key needs no delete. A concurrent replacement causes a revision conflict.

The command then reads the named keys and the metadata index rows again.
It reads the root row and the bucket row of each named slug. It refuses a bucket row that holds a slug of another bucket.
It removes index entries only for acknowledged slugs whose metadata remains absent.
It sends one complete replacement for each changed metadata row, conditioned on that row's observed revision.
It keeps the content and order of every unrelated entry.
It sends no index write when the rows or the relevant entries are absent.
A final batch read observes the named keys and their metadata entries.

CAUTION: The Delete batch and the metadata repair are separate requests.
A failure can leave a deleted secret with an old metadata entry.
A concurrent write can recreate a named key or change the rollup.
The command refuses ambiguous metadata and stops after a conflict or an uncertain write.
The read and its conditional mutation are separate operations. The revision check rejects intervening changes.
It does not retry automatically. Read the value-free JSON receipt before a separate cleanup attempt.
Exit 0 means the Delete batch received an ack and the final metadata reads show absence.
The result is an observed metadata state. It does not prove full-record or secret-value tip absence.
The receipt states both absence limits as false.
It does not prove the removal of historical bytes or backups.
It does not revoke a provider credential or delete a remote account.

## Agent and Automation Policy

Agents must use LastSecrets for writing or retrieving secrets. Raw values are
accepted only at the point of use: `lastsecrets put ... --value-stdin` stores a
value, and `lastsecrets get <slug>` retrieves it only for the command that needs
the plaintext. Brain, Kanban, docs, runbooks, PR bodies, CI configs, and logs
must persist only `lastsecrets://<slug>` locators.

If LastSecrets is unavailable, stop before handling raw secret material and ask
Tom how to proceed. Do not fall back to putting credentials in chat, F-Brain,
F-Kanban, source files, logs, PR descriptions, or CI variables.

Before publishing docs or automation changes that mention credentials, run:

```sh
lastsecrets guard AGENTS.md README.md
```

`lastsecrets guard [PATH...]` is a lightweight persistence check. It scans text
files for high-confidence provider token shapes and generic secret assignments,
prints only redacted previews, and exits non-zero when a human should replace
the value with a LastSecrets record plus locator. It intentionally ignores
`lastsecrets://...` refs and environment-variable placeholders.

## Threat Model

LastSecrets is a local LastDB client, not a network vault. The first threat boundary is accidental disclosure through developer workflows: logs, errors, search output, test snapshots, and references must not contain raw secret values. The CLI therefore accepts writes only through `--value-stdin`, stores the value in the `secret_value` field, and redacts that field everywhere except `lastsecrets get <slug>`.

Metadata is intentionally searchable. Treat `slug`, `label`, `provider`, `purpose`, and `environment` as non-secret review data; do not put credentials, bearer tokens, passwords, or private key material in those fields.

LastDB owns local durability. A restricted install talks to the app socket named by `LASTDB_SOCKET_PATH` and can read and write only the schemas named in `lastdb-app.json`. Field classification keeps `secret_value` out of automatic indexes. If a caller copies `lastsecrets get` output into logs or another database, that disclosure is outside LastSecrets' control.

## Development

```sh
bun run typecheck
```

The tests are deleted (Tom, 2026-10-09). The `gate` job runs the shell syntax checks, the typecheck, and a per-file bun build in `.lastgit/ci.sh`.

## Canonical field vocabulary

Schema definitions use the reviewed names in `src/canonical-fields.json`.
The installer places them from `lastdb-app.json`. LastSecrets does not declare schemas at run time and never writes to Schema Service.
No special vocabulary key or operator approval path exists.
`lastdb-app.json` lists the same two canonical schemas, with every field typed. After a schema change, run `bun scripts/write-app-manifest.ts` to regenerate that list from `src/schema.ts` and `src/canonical-fields.json`.
`lastsecrets vocabulary-json` exports the definitions. `lastsecrets schema-json` exports the canonical secret schema.
Neither command reads secret values.

The command interface keeps local names such as `slug` and `label`.
An explicit field map translates these names at the transport boundary.
The config stores this map under the exact schema names. Reads and writes send those names.
The map does not copy records or add another field key.

CAUTION: New canonical names are a manifest change. The installer places the new definitions. The app does not declare them.
`init` rewrites the local config to the exact schema names and the installed field map. It does not contact the node.
A config that still stores a 64-hex schema id must be written again with `lastsecrets init` before a read or a write.
The config write uses an atomic replacement and flushes the file and its directory.
Ordinary reads and writes use the saved schema names. They never declare schemas or retry a write.

## CI comparison

The CI latency comparison uses the actual CLI. It compares the old app (the PR base) with the new app.
Both arms run the same latest lastdb nightly daemon. Each arm records the observed home format and API version.
Each arm creates its own fresh home. No arm changes an old home.
Two AB/BA pairs start with 64 records and 4096 bytes per value.
Every operation retains 64 calls per arm.
Complete values, metadata membership, deletion, repeat setup, and reopen remain required.
Reopen and repeated setup must keep the values and the record metadata.
Before the timed updates of this app, 12 metadata entries move to the root row. The updates and the delete must remove them from the root row.
Latency includes the CLI process and all requests; it does not isolate database latency.

Each timed call retains child CPU time and bounded daemon and host counter observations.
The counter reads occur outside the timer and change the gaps between calls for both sources.
Results with those observations form a separate experiment from earlier runs without them.
The summary also shows create and update tails for each arm. No sample is removed or trimmed.
Host pressure shows shared load; it does not prove the cause of a request delay.
Missing counters stay unreported. Raw observations pass the output audit before artifact upload.
