Fixes false "temporarily unavailable" errors

### Fixed

- **"Kortix is temporarily unavailable" when nothing was wrong.** A single failed read of the maintenance flag was treated as a decision to lock the platform down. The API then rejected every write and showed that message to everyone using Kortix, with no one having touched the maintenance setting. An unreadable flag now means normal operation. Maintenance mode is only ever an explicit action, and a real one still holds while the flag store is briefly unreachable.

- **Being sent to the maintenance page after one failed status check.** A momentary network problem in the browser was enough to navigate you out of a working session. It no longer is.

### Security

- Updated the SSH library bundled in our app runtime past CVE-2026-56854, an authentication bypass caused by source-address restrictions not being enforced (`golang.org/x/crypto` 0.53.0 to 0.55.0).

### Internal

- Two browser errors that were never Kortix defects — one thrown by a browser extension, one by the graphics library behind our background visuals — no longer report as product errors in our monitoring.
