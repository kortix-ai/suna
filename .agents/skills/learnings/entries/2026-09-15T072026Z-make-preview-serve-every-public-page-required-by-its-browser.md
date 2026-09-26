---
recorded: 2026-09-15T07:20:26Z
incident_date: 2026-09-15
commit: c22035d0b3
---
# Make preview serve every public page required by its browser gate

**When:** configuring a full preview stack. Keep marketing enabled if `target-full` probes `/pricing`; check the preview origin before interpreting a missing heading as a frontend defect. *Near-miss:* the v0.13.15 preview gate followed `/pricing` to `/auth` because `KORTIX_PUBLIC_DISABLE_LANDING_PAGE` was `true`. *Enforcer:* `tests/src/core/preview-stack.ts` sets the flag to `false`, and the target browser journey asserts pricing content.
