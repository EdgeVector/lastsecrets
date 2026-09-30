# CI

`ci-required.yml` is the gate of record. GitHub is the source of truth for
`EdgeVector/lastsecrets` since 2026-09-30. The `ci-required` job is the required
check on `main`. The `publish` job builds the host-track artifact on a push to
`main`. LastGit and Forgejo copies are frozen.
