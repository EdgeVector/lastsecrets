# LastGit home — lastsecrets

| Role | Location |
|------|----------|
| **SoT / CR / CI / merge** | `lastdb:///lastsecrets` on code node |
| **Public install mirror** | `https://github.com/EdgeVector/lastsecrets` (invitees / cold install) |
| **Rollback remote** | Forgejo may remain browse/rollback only |

## Secret-scan
Test fixtures use AWS EXAMPLE keys. Set `LASTGIT_DISABLE_SECRET_SCAN=1` **only
on push**, never on the CI watcher.
