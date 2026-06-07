Desktop app, unified channel delivery & reliability fixes

**Desktop**
- Product-only desktop app shell with a new Download apps page and a frontend-URL switcher.
- Visitor-tracking pixels suppressed inside the desktop app.

**Channels & Slack**
- Unified all channel message delivery into one canonical server-side path (removed the legacy queue drainer/storage/routes).
- Slack manifest webhook URL now derives from the public API origin; post-install OAuth now lands on the Customize → channels view; dev Slack app pointed at the new KortixDev app / dev-api.

**Web & API reliability**
- Brand-compliant container radii; third-party Sentry Promise.then tampering noise suppressed.
- Bounded the Daytona snapshot lookup so /sandbox-health can't hang.

**Release pipeline**
- Promote pre-flight green-gate hardened (ignores the promote run's own check and superseded duplicate checks); deploy-prod retag now falls back to :dev-latest per image so a single-surface commit promotes cleanly.
