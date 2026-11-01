# CI

`ci-required.yml` is the gate of record. GitHub is the source of truth for
`EdgeVector/lastsecrets` since 2026-09-30. The `ci-required` job is the required
check on `main`. The `publish` job builds the host-track artifact on a push to
`main`. LastGit and Forgejo copies are frozen.

`schema-values-latency.yml` runs the normal LastSecrets CLI on generated homes.
It uses exact app and LastDB revisions and registered definitions.
The job sets `ENVIRONMENT=dev`. The definition check and both daemons use the DEV Schema Service from the daemon source.
CI does not depend on production publisher authority.
The main app runs on the compatible format 6 daemon. This app runs on a format 7 daemon from lastdb main.
This app also runs the same steps once, untimed, on the format 6 daemon.
Each arm must open the expected home format.
Each arm creates its own fresh home. No arm changes an old home.
Two balanced pairs compare the CLI requests of the two arms.
The seed has 64 records with 4096 bytes per value. Both arms create 64 more records during the timed requests.
All known values, metadata membership, repeat setup, deletion, and reopen remain required.
A format 6 home also keeps its atom identities and author metadata. A format 7 home has none.
Before the timed updates of this app, 12 metadata entries move to the root index row. The updates and the delete must remove them from that row.
Timings are advisory.
Raw values stay in process memory and the generated encrypted homes. CLI value output never enters an artifact or error.
The required comparison rejects failed operations, incomplete samples, and failed artifact checks. It does not prove a primary upgrade.
