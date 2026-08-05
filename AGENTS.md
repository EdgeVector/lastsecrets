# LastSecrets Agent Instructions

Use LastSecrets for all secret writes and reads in this repo.

- Store raw values only with `lastsecrets put <slug> ... --value-stdin`.
- Retrieve raw values only at the point of use with `lastsecrets get <slug>`.
- Persist only `lastsecrets://<slug>` locators in Brain, Kanban, docs, logs,
  PR bodies, CI configs, LastGit CRs, and source files.
- Run `lastsecrets guard [PATH...]` before publishing docs or automation changes
  that mention credentials.
- If LastSecrets is unavailable, stop before handling raw secret material and ask
  Tom how to proceed.
