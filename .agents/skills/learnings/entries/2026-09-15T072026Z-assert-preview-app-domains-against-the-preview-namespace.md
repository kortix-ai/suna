---
recorded: 2026-09-15T07:20:26Z
incident_date: 2026-09-15
commit: c22035d0b3
---
# Assert preview App domains against the preview namespace

**When:** testing project App URLs on a preview origin. Use the preview App namespace instead of the production `apps.kortix.com` pattern. *Near-miss:* the v0.13.15 preview gate rejected a working `preview-…apps.eu-west.sbx.platinum.dev` URL. *Enforcer:* `tests/e2e/specs/18-apps-ui.spec.ts` uses a preview-specific host assertion.
