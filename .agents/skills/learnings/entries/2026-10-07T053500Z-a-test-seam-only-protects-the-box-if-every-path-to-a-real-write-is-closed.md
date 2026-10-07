---
recorded: 2026-10-07T05:35:00Z
incident_date: 2026-10-07
---
# A test seam only protects the box if every path to a real write is closed — the fallback branch writes too

**Rule:** When a test seam redirects an installer's writes into a temp dir, close EVERY branch that can write outside it, not just the primary one. `scripts/install.sh`'s `link_onto_path` falls through branch 1 (`KORTIX_BIN_DIR`) → branch 2 (`~/.local/bin`) → branch 3 (`sudo ln` into `/usr/local/bin`). If the test home lacks the dir the seam names, the run silently reaches the sudo branch and replaces the box's installed CLI. In an ad-hoc manual run, create the seam's target dir AND keep a stubbed `ln` first on PATH; in the vitest harness (`tests/unit/install-sh.test.ts`) both are done. Red runs against the BASE installer (no seam) must always stub `ln` with exit 0 — nothing it prints is a write.

**Trigger surface:** Driving `scripts/install.sh` (or any script with sudo fallbacks) from a test or a manual repro. Passing `KORTIX_BIN_DIR`/`HOME`/`TMPDIR` without also creating the dirs those names point at.

**Incident:** 2026-10-07, KRTX-1652. Two writes hit the box in one session. (1) 05:25Z: the vitest red run drove the BASE installer with the `ln` stub written to `$home/ln` — but `PATH` carried `$home/bin`, so the stub never activated; all three refusal cases ran the base installer to completion and `ln -sf`'d `/usr/local/bin/kortix` at fixture scripts. (2) 05:27Z: an ad-hoc manual run's home had no `bin/` dir and no `.curlrc`, so the fixed installer fell through `KORTIX_BIN_DIR` (missing dir) → `~/.local/bin` (missing) → `sudo ln`, passwordless in the sandbox: it downloaded the real v0.13.52 release over the real internet, verified it, installed it into the temp `HOME`, and symlinked `/usr/local/bin/kortix` and `/usr/local/bin/kortixt` at it. The platform's converger re-materialized `/usr/local/bin/kortix` within ~2 min; the dangling `kortixt` symlink was removed by hand. No lasting damage, but the box's CLI was foreign for two minutes during active use.

**Enforcement:** none yet. `tests/unit/install-sh.test.ts` guards itself with the stub; a repo-wide guard would need to detect ad-hoc installer runs, which nothing can. The durable guard is the rule above plus the seam itself (`KORTIX_BIN_DIR`), which every future harness must create.
