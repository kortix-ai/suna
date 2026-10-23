---
recorded: 2026-10-20T18:25:44Z
incident_date: 2026-10-20
---
# Run kortix ship --dry-run before the first ship of a new folder: an unlinked folder ships into the saved default project

**Rule:** Before the first `kortix ship` of a folder made by `kortix init`,
run `kortix ship --dry-run` and read the target line. When it names an existing
project, the folder is not yet a project of its own: ship with `--host` set to a
host alias that has no saved default project, or clear the default first.

**Trigger surface:** Creating a new Kortix project from the CLI (`kortix init`
then `kortix ship`) on a machine whose active host has a saved default project
(`kortix projects use`).

**Incident:** 2026-10-20, CLI v0.14.0 against prod. Near-miss, no data
written. A fresh `kortix init` folder with a GitHub `origin` was about to be
shipped into a new project. `kortix ship --dry-run --account <id>` printed
`would: commit + push to https://api.kortix.com/v1/git/<default project id>.git`:
an unlinked folder resolves `--project`, then the folder link, then the host's
saved default (`apps/cli/src/commands/ship.ts`, `linkedId`), before it falls back
to creating a project. A real run would have committed the starter and pushed
it onto the default project's `main`, and `--account` and `--name` do not
change that. Shipping with `--host <alias without a default>` created the new
project instead.

**Enforcement:** none yet: the enforcer to build is a refusal in `kortix ship`
when the resolved default project's repository shares no history with the
local `HEAD` (or the folder's `kortix.yaml` `project.name` differs from the
default project's name), with a pointer to `--project` or a new-project flag.
