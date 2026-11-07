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

LastSecrets requires LastDB API 29 or later and explicit record keys.
The secret records and metadata summaries use separate schemas that own their values.
Canonical field definitions stay reusable. They do not share record values.
These are separate record types, so this change adds no alternate key.
A home on an older node moves to this release only by the home copy. See "Existing homes" below.

The initial schema contract is defined in `src/schema.ts`.

`secret_value` is deliberately a normal object field with secret/no-index classifications. Secrecy is a field policy, not a distinct primitive value type.

## CLI

Initialize the local LastDB-backed config:

```sh
lastsecrets init
```

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
It uses the current owner access and the same configured schema route as get and put.
It reads the node API version with the schema list and requires API 29 or later before reading keys.
It selects the configured name first, or the saved hash when the name is absent.
It requires one exact installed name, the correct owner, complete field names, a hash key, and state Available.
It verifies the saved hash and current identity hash formats. Those hashes can differ after an identity algorithm change.
A retired name claim remains valid for this exact installed route. The command never switches to another schema name.
LastDB returns complete records, including secret values, over the owner connection.
LastSecrets keeps the selected metadata and record revision for deletion and emits a receipt containing only references and outcomes.
Each read collects all selected keys and sends them as native keyed query batches of at most 64 keys, in parallel.
A verified empty query result means the key is absent.
A malformed, incomplete, or out-of-scope query result stops that path before a mutation.
It sends one native Delete batch for the named records that exist, using each observed record revision.
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

## LastGit CI Contract

LastGit CRs and CI definitions should carry `lastsecrets://<slug>` locators, not
plaintext values. A runner that needs a secret resolves the locator at execution
time, injects the value into the child process environment or stdin, and redacts
the value from status, logs, summaries, and retry metadata. Resolution failure is
a hard preflight error: the runner should not continue with an empty placeholder
or ask an agent to paste the raw value into LastGit.

## Migrating raw secrets out of Brain

Some Brain records may still contain raw secret values inline. `lastsecrets migrate`
provides a **reviewable, staged** path from those raw values to `lastsecrets://`
references. It never does a broad destructive rewrite.

The flow is two-phase:

1. **Plan (default, read-only).** Scan the named Brain schema(s)/field(s) for
   secret material, classify every hit, and print a migration log. Nothing is
   written.

   ```sh
   lastsecrets migrate --schema brain/Note --fields body,title --log migration.plan.log
   ```

2. **Apply (`--apply`).** Execute only the **high-confidence** staged actions:
   store each secret through LastSecrets, then replace the raw value in the
   owning Brain record with its `lastsecrets://` locator. Uncertain detections
   are left untouched.

   ```sh
   lastsecrets migrate --schema brain/Note --fields body,title --apply --log migration.apply.log
   ```

Classification:

- **High confidence** (staged, applied under `--apply`): provider token shapes
  (AWS/GitHub/Slack/Stripe/OpenAI/Anthropic/Google keys), JWTs, and PEM private
  key blocks.
- **Uncertain** (recorded as `needs review`, **never** rewritten automatically):
  generic `secret = ...` / `password = ...` / `token = ...` assignments, which
  can be schema field names, documentation, or placeholders.

Placeholders (`<redacted>`, `${ENV_VAR}`, `changeme`, already-migrated
`lastsecrets://...` refs, values under 8 chars, …) are ignored.

The migration log records, for every scanned record: what was **staged**, what
**needs review**, and what was **intentionally left untouched** — and, after an
apply, how many secrets were stored, how many records were updated, and any
errors. Raw secret values never appear in the log (previews are redacted).

## Threat Model

LastSecrets is a local LastDB client, not a network vault. The first threat boundary is accidental disclosure through developer workflows: logs, errors, search output, test snapshots, and references must not contain raw secret values. The CLI therefore accepts writes only through `--value-stdin`, stores the value in the `secret_value` field, and redacts that field everywhere except `lastsecrets get <slug>`.

Metadata is intentionally searchable. Treat `slug`, `label`, `provider`, `purpose`, and `environment` as non-secret review data; do not put credentials, bearer tokens, passwords, or private key material in those fields.

LastDB owns local durability and access to the socket. LastSecrets relies on the local owner socket and schema field classifications to keep `secret_value` out of automatic indexes. If a caller copies `lastsecrets get` output into logs or another database, that disclosure is outside LastSecrets' control.

## Development

```sh
bun run typecheck
```

The tests are deleted (Tom, 2026-10-09). The `gate` job runs the shell syntax checks, the typecheck and the artifact build in `.lastgit/ci.sh`.

## Canonical field vocabulary

New schema declarations use the reviewed definitions in `src/canonical-fields.json`.
A fresh home submits these definitions through normal schema declarations on the local LastDB node.
LastSecrets never writes to Schema Service itself.
No special vocabulary key or operator approval path exists.
`lastdb-app.json` lists the same two canonical schemas, with every field typed. After a schema change, run `bun scripts/write-app-manifest.ts` to regenerate that list from `src/schema.ts` and `src/canonical-fields.json`.
`lastsecrets vocabulary-json` exports the definitions. `lastsecrets schema-json` exports the canonical secret schema.
Neither command reads secret values.

The command interface keeps local names such as `slug` and `label`.
An explicit field map translates these names at the transport boundary.
The config stores this map for each registered schema identity. Reads and writes use the pinned canonical identity.
The map does not copy records or add another field key.
A config without this map retains its existing data path.

CAUTION: New canonical names produce new schema identities.
A config without a field map keeps its existing field names.
All new declarations require schema-owned values, with or without a field map.
`init` refuses a node older than API 13 before the first declaration.
It also refuses a change to a saved definition identity.
The config write uses an atomic replacement and flushes the file and its directory.
Ordinary reads and writes use the saved schema addresses. They never declare schemas or retry a write.

## Existing homes

This release requires LastDB API 13 or later (lastdb #803). It does not change a home in place. It has no command for old homes.

CAUTION: Do not use this release on a node older than API 13.
On that node, `init` refuses a home that holds LastSecrets schemas with `home_copy_required` and make no change.
`delete` refuses that node with `home_copy_required` and makes no change.

A home on an older node moves to this release only by the home copy (EdgeVector/last-stack#377):

1. The home copy reads the old home. It does not change the old home.
2. The home copy writes the `LastSecret` and `LastSecretIndex` records, with the secret values, to a new home.
3. This release initializes the new home with `lastsecrets init`.
4. The old home stays unchanged as the recovery point.

CAUTION: A format 7 home refuses a record above 64 KiB. An earlier release adds every new entry to `__all__`. Use this release for each new secret before a copy to a format 7 home. This release adds no entry to `__all__`.

A primary change requires Tom's authorization.

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
