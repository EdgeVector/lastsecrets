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

## Development

```sh
bun test
```
