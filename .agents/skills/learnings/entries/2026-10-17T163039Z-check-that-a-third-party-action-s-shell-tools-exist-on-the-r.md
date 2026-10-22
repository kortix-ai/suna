---
recorded: 2026-10-17T16:30:39Z
incident_date: 2026-10-17
---
# Check that a third-party action's shell tools exist on the runner image before you trust a red deploy job

**Rule:** When a pinned third-party action shells out to a system tool (`envsubst`, `jq`, `gpg`), install or assert that tool in a step before the action. Runner images drop packages without notice. When a deploy job goes red, read its failing step before you blame your own change.

**Trigger surface:** Adding or bumping a `uses:` step in `.github/workflows/deploy-*.yml`, or reading a red Deploy Dev run after a merge.

**Incident:** 2026-10-17. Every Deploy Dev run that built the API (from 13:21Z, runs 39036221308 to 39040200775) failed in `Scan + SBOM + sign API image`. `sigstore/cosign-installer` exited 127 with `envsubst: command not found`. The deploy itself completed, so dev served each new SHA, but no API image was signed and every run read as failed. Fixed by #10137 (an "Ensure envsubst" step that installs `gettext-base`), proven by run 39041165715.

**Enforcement:** none yet: the next Deploy Dev run goes red at the same step if the tool disappears again. A workflow unit test asserting an `envsubst` guard before `cosign-installer` would catch a removal of the guard.
