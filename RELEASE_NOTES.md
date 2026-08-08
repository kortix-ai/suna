Legacy chat restore, billing correctness, and admin consoles

**New**
- Imported legacy Suna chats are now first-class: migrated sessions show up in the session list with a restore state (instead of a misleading "Done"), and opening one restores its full conversation history into the session. Files from every imported chat live in the project repo under `legacy/`. (#6235, #6241, #6251)
- Admin: an activity-analytics dashboard, a projects console, clearer tier labels, and admin-issued trials with per-account entitlement overrides. (#6244, #6249, #6250)
- Apps: serverless app deployments are provider-neutral — any Dockerfile runtime builds and serves (including non-root images), and the first request after idle reliably wakes the app. (#6253)
- Reloading a busy session asks before stopping the running turn, and says clearly when a turn was stopped.

**Improved**
- Setup links: secret links now last 7 days, an expired link says it expired instead of "invalid", and completing one notifies the waiting session immediately. (#6240)
- Faster navigation between projects and sessions: one cache entry per entity, and route segments are no longer discarded on the way. (#6231)
- Browser tabs are named after the session you have open. (#6236)

**Fixed**
- Billing: subscriptions activate only after the first invoice is paid; compute metering opens and closes windows atomically with precise start times; sandbox resume reconciliation is fenced so a wake race can't double-bill; a ledger row can no longer be both usage and an admin debit. (#6247, #6248)
- The terminal stays attached when the session runtime restarts during a reload.
- Removed noisy request-timeout toasts.
- Firefox no longer shows a crash message from the background shader when WebGL is unavailable. (#6254)

**Removed**
- The local Docker sandbox provider. Sessions run on cloud sandboxes.
