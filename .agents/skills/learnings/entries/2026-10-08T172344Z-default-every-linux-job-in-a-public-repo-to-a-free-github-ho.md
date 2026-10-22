---
recorded: 2026-10-08T17:23:44Z
incident_date: 2026-10-08
---
# Default every Linux job in a public repo to a free GitHub-hosted runner; a paid runner needs a measured reason

**Rule:** Default every Linux job in this public repo to a standard GitHub-hosted runner (`ubuntu-24.04`, `ubuntu-24.04-arm`, `ubuntu-22.04`). Its minutes cost $0. Move a job to a paid runner (Blacksmith, a GitHub larger runner) only after a measurement shows the speed is worth the price. When a job moves between runner images, run it once on the new image before the merge: an image can lack a tool (`rg`) or the memory the old one had.

**Trigger surface:** A `runs-on` / matrix `runner:` default in `.github/workflows/`, a vendor's migration-wizard PR, a new runner vendor, a tool call in `tests/bin/` that assumes a binary on the runner.

**Incident:** In July and August 2026 suna ran 136,522 and 148,393 Linux minutes on GitHub-hosted runners, billed $0 net. On 2026-08-26 #6901 (Blacksmith's migration wizard) and #6902 moved every Linux job to Blacksmith for speed and a sticky-disk Docker cache. Blacksmith billed ~$2.7k for September. 82% of it was 8 vCPU lanes, and 47% was failed or cancelled runs. The sticky disk reused 0 layers in the 2026-08-25 measurement; the registry cache did the caching. The move back (branch `ci-cost`) found three things the Blacksmith image had hidden: `tests/bin/package-quality.ts` spawned `rg`, which GitHub images do not ship; a race test slept a fixed 300 ms; and four browser shards with two Playwright workers overran a 16 GB runner. The fixes were `git grep --untracked`, a wait for the row mark, and eight one-worker shards.

**Enforcement:** `tests/unit/image-build-speed-workflow.test.ts` → "every Linux job defaults to a free runner behind the runner switch": every `CI_RUNNER_<tier>` default must match `ubuntu-2x.04[-arm]`, and no workflow may use `useblacksmith/` actions. A `CI_RUNNER_<tier>` repository variable still moves a tier to a paid pool without a PR.
