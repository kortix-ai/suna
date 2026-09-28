---
recorded: 2026-08-26T17:23:14Z
incident_date: 2026-08-26
commit: 8c72d88d48
---
# A runner migration re-tests every setup action; one job on a different major is a latent break

**When:** moving a workflow to a different runner image (Blacksmith), or
bumping a setup action (`pnpm/action-setup`, `setup-node`) in ONE job of a
multi-job workflow. `tests-release.yml` ran `pnpm/action-setup@v4` in three
jobs and `@v6` in the `deployed browser shard` only (dependabot #6343 bumped
one). On GitHub's `ubuntu-latest` no pnpm is preinstalled, so both majors
behaved the same and the v0.13.5 gate was green. The Blacksmith image ships
pnpm v11.19.0 at `PNPM_HOME`; `@v6`'s self-installer took its "Switching pnpm
from v11.19.0 to v8.11.0" path, warned `Failed to create bin ... @pnpm/exe ...
ENOENT`, and left a standalone `@pnpm/exe` on PATH. That binary runs on its
own bundled Node (18.5.0), so `pnpm install --frozen-lockfile` failed
`engine-strict` against `eslint@9.39.4` (`Got: v18.5.0`) although
`setup-node` had put 22.22.0 on PATH one step earlier. All three browser
shards of the v0.13.6 gate died in ~60 s; the api shards on the SAME runner
label passed on `@v4`.
Rules: (1) every job in a workflow uses one major of each setup action — a
dependabot bump that touches one `uses:` line of four is a review reject;
(2) after a runner-image migration, run the release gate as a dry run
(`gh workflow run tests-release.yml --ref staging -f expected_sha=<sha>`)
BEFORE the next promote — Blacksmith (#6906) moved the gate on 2026-08-25 and
the first real run was the release; (3) a whole-shard failure in well under
the usual runtime is a setup failure — read the install step, not the tests
(same class as the 2026-08-18 lockfile entry).
*Incident:* v0.13.6 release PR #6923, gate run 32992496089; fixed by #6925 /
#6926 (pin `@v4`); ~1 h of release delay on top of the GitHub Actions outage.
*Enforcer:* none — a lint that every `pnpm/action-setup@` in a workflow file
shares one major is the TODO.
