<!-- last-stack:no-tests:start -->
## No tests or test coverage requirements (Tom, 2026-10-09)

Situation: `no-tests-all-repos-20261009`.
Decision: `decision-2026-10-09-retire-all-tests-and-test-coverage`.

- Do not write, add, run, restore, or require tests.
- Remove tests and test coverage requirements from CI and all linters.
- Remove earlier test requirements from agent rules, skills, and routines when found.
- This rule supersedes fixture-test, mutation-probe, coverage, and test-gate rules.
- Keep product code and non-test build, format, lint, secret, and deployment checks.
<!-- last-stack:no-tests:end -->

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
- The tests are deleted (Tom, 2026-10-09). The gate runs shell syntax checks, typecheck and the artifact build.
