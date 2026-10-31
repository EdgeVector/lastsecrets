# CI

`ci-required.yml` is the gate of record. GitHub is the source of truth for
`EdgeVector/lastsecrets` since 2026-09-30. The `ci-required` job is the required
check on `main`. The `publish` job builds the host-track artifact on a push to
`main`. LastGit and Forgejo copies are frozen.

`schema-values-latency.yml` runs the normal LastSecrets CLI on generated homes.
It uses exact app and LastDB revisions and registered definitions.
The job sets `ENVIRONMENT=dev`. The definition check and both daemons use the DEV Schema Service from the daemon source.
CI does not depend on production publisher authority.
The main app runs on the compatible daemon. This app runs on the removal daemon.
Each arm creates its own fresh home. No arm changes an old home.
Two balanced pairs compare the CLI requests of the two arms.
The seed has 64 records with 4096 bytes per value. Both arms create 64 more records during the timed requests.
All known values, metadata membership, current atom identities, author metadata, repeat setup, deletion, and reopen remain required.
Timings are advisory.
Raw values stay in process memory and the generated encrypted homes. CLI value output never enters an artifact or error.
The required comparison rejects failed operations, incomplete samples, and failed artifact checks. It does not prove a primary upgrade.
