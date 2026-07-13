# LastSecrets

LastSecrets stores local secrets in LastDB while keeping raw secret values out of automatic search indexes.

The durable contract is:

- raw values live in LastDB records owned by the LastSecrets app;
- Brain and other apps store `lastsecrets://...` references, not raw values;
- secret value fields use normal value types plus `secret` / `no_index` field classifications;
- searchable metadata is opt-in through explicit `word` classification;
- no embeddings or generated indexes are committed to Git.

## Initial Schema

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

## Migrating raw secrets out of Brain

Some Brain records may still contain raw secret values inline. `lastsecrets migrate`
provides a **reviewable, staged** path from those raw values to `lastsecrets://`
references. It never does a broad destructive rewrite.

The flow is two-phase:

1. **Plan (default, read-only).** Scan the named Brain schema(s)/field(s) for
   secret material, classify every hit, and write a redacted text log plus a
   redacted JSON review file. Nothing is written.

   ```sh
   lastsecrets migrate --schema brain/Note --fields body,title \
     --log migration.plan.log \
     --review migration.review.json
   ```

2. **Review.** Inspect `migration.plan.log` and `migration.review.json`.
   High-confidence actions are marked `"decision": "apply"` by default.
   Uncertain detections are marked `"decision": "review"` and are never applied
   unless an operator explicitly changes that one action to `"apply"` after
   validating it out of band. Use `"skip"` for candidates that must remain
   untouched.

3. **Apply (`--apply`).** Re-scan the same Brain targets, read the review file,
   and execute only entries whose redacted action id/ref/preview still match and
   whose decision is `"apply"`: store each secret through LastSecrets, then
   replace the raw value in the owning Brain record with its `lastsecrets://`
   locator.

   ```sh
   lastsecrets migrate --schema brain/Note --fields body,title \
     --apply \
     --review migration.review.json \
     --log migration.apply.log
   ```

4. **Guard artifacts before sharing.** Check every generated plan/log/review file
   against any throwaway raw value handled during a test run. Pass the value on
   stdin so it does not appear in shell history, process lists, or command logs.

   ```sh
   printf '%s' "$THROWAWAY_VALUE" | lastsecrets guard --file migration.plan.log --value-stdin
   printf '%s' "$THROWAWAY_VALUE" | lastsecrets guard --file migration.review.json --value-stdin
   printf '%s' "$THROWAWAY_VALUE" | lastsecrets guard --file migration.apply.log --value-stdin
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
errors. Raw secret values never appear in the log or review JSON; previews are
length-only redactions such as `<redacted:40 chars>`.

Operator-safe runbook for a real Brain migration:

- Use a narrow schema/field set first; do not run a broad Brain rewrite without
  a reviewed plan.
- Keep plan, review, and apply artifacts local with restrictive file modes.
- Store raw values only through LastSecrets at apply time. Do not paste them into
  Brain, Kanban, PR descriptions, docs, screenshots, or terminal snippets.
- Record durable evidence as counts, `lastsecrets://` refs, and residual manual
  review classes only. Do not record raw values or redacted fragments that reveal
  token prefixes/suffixes.
- Leave unresolved `"review"` or `"skip"` actions as an explicit manual-review
  remainder; do not silently rewrite uncertain candidates.

## Threat Model

LastSecrets is a local LastDB client, not a network vault. The first threat boundary is accidental disclosure through developer workflows: logs, errors, search output, test snapshots, and references must not contain raw secret values. The CLI therefore accepts writes only through `--value-stdin`, stores the value in the `secret_value` field, and redacts that field everywhere except `lastsecrets get <slug>`.

Metadata is intentionally searchable. Treat `slug`, `label`, `provider`, `purpose`, and `environment` as non-secret review data; do not put credentials, bearer tokens, passwords, or private key material in those fields.

LastDB owns local durability and access to the socket. LastSecrets relies on the local owner socket and schema field classifications to keep `secret_value` out of automatic indexes. If a caller copies `lastsecrets get` output into logs or another database, that disclosure is outside LastSecrets' control.

## Development

```sh
bun test
bun run typecheck
```
