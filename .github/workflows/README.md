# CI

`ci-required.yml` is the gate of record. GitHub is the source of truth for
`EdgeVector/lastsecrets`. The `ci-required` job is the required check on `main`.
It runs shell syntax checks, a frozen install, typecheck, and a per-file bun build.
A push to `main` then runs `registry-commit`.

`schema-values-latency.yml` runs the normal LastSecrets CLI on generated homes.
It compares the old app (the PR base, or the previous main on a push) with the new app.
Both arms run the same latest lastdb nightly daemon, downloaded prebuilt and checked against its release checksums.
Daemon-vs-daemon comparisons belong in lastdb's own benchmark CI.
The job sets `ENVIRONMENT=dev`. The daemon uses the DEV Schema Service. LastSecrets itself writes no schema to Schema Service.
CI does not depend on production publisher authority.
Each arm records the observed home format and API version.
Each arm creates its own fresh home. No arm changes an old home.
Two balanced pairs compare the CLI requests of the two arms.
The seed has 64 records with 4096 bytes per value. Both arms create 64 more records during the timed requests.
All known values, metadata membership, repeat setup, deletion, and reopen remain required.
Reopen and repeated setup must keep the values and the record metadata.
Before the timed updates of this app, 12 metadata entries move to the root index row. The updates and the delete must remove them from that row.
Timings are advisory.
Raw values stay in process memory and the generated encrypted homes. CLI value output never enters an artifact or error.
The required comparison rejects failed operations, incomplete samples, and failed artifact checks. It does not prove a primary upgrade.
