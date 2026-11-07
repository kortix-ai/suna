Notifications with an Inbox, flag-free Artifacts, and sturdier APIs

Notifications with an Inbox, flag-free Artifacts, and sturdier APIs

### New

- Notifications are on for every project, and a new Inbox page in the sidebar replaces the bell. (#11959)
- Artifacts no longer need a feature flag. Artifact comments have been removed. (#11963)

### Improved

- The Inbox moves out of the sidebar into the workspace menu. (#11986)
- Trigger rows truncate long names and count down to the next run. (#11972)

### Fixed

- A chat link to a drive file opens the file preview instead of a 404. (#11954)
- A down user-app port no longer logs a warning on every proxy retry. (#11948)
- The needs-input badge poll no longer surfaces as an error toast or a Sentry event. (#11952)
- The connector catalogue restarts at page 1 when its cursor can't be decoded. (#11960)
- Session costs answer 400, not 500, for a malformed owner id. (#11962)
- Per-member IAM routes answer 400 for a non-UUID member id. (#11961)
- A missing project now shows the same 404 as the rest of the app. (#11965)
- security.txt is served through the test-environment gate. (#11967)
- The /a1o canvas is skipped on browsers without WebGL2 instead of failing. (#11977)
- A blocked gapi script load no longer makes a page retry forever. (#11985)
- A run that compacts its context still stops at its agent's step cap. (#11725)

### Internal

- Test isolation across @kortix/db and @kortix/voice, with shared stubs exporting withDbTransaction and resolvePrincipal and the runner contract recording them isolated. (#11968, #11974, #11976, #11978, #11982)
- Flow test scaffolding deduped into shared fixtures. (#11984)
- Web cleanup: dead palette rows, the settings kind and sitemap duplicates removed; docs generators, Sentry init and entrypoint rules unified. (#11955, #11966)
- The document-review state CLI is smaller. (#11973)
- The self-host migrate image ships ledger-repair, and the v0.15.1 release suite is green. (#11956)
- The big-store recovery pass runs with 2 vCPU and 16 GB. (#11950)
