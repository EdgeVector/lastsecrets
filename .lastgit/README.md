# LastGit home — lastsecrets (frozen)

GitHub `EdgeVector/lastsecrets` is the source of truth since 2026-09-30
(`decision-2026-09-29-retire-lastgit-all-repos-to-github`). The LastGit and
Forgejo copies are frozen. CI is `.github/workflows/ci-required.yml`; it calls
`.lastgit/ci.sh` as the test body and `.lastgit/artifacts.json` declares the
host-track artifact.

## Secret-scan
Test fixtures use AWS EXAMPLE keys.
