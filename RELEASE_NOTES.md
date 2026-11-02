Files never block a session, storage limits and storage billing, searchable session continuity

### New
- Files storage limits per project and per account, by plan: Free 5 GB, Credits 50 GB per project and 250 GB per account, Enterprise 100 GB per project and 1 TB per account. An upload that does not fit is refused before it starts, with what is used, what it needs and what is left (#11435, #11459).
- Files storage is billed in credits at cost, like compute: project Files, each session's workspace and scratch disks. Billing shows Storage per project next to compute (#11435).
- The Files page shows a project's storage against its limit and warns before a folder is too large to mount in a session (#11435).
- Full contexts continue from the searchable session record instead of a summary (#11428).
- My Kortix can set up event-driven automations with filters, per-item sessions, caps, dry runs, and review (#11430).
- My Kortix can build and retire watcher Apps that post App events (#11440).

### Improved
- New sessions in large projects request their box up to 1.6 seconds sooner (#11419).
- Connector calls no longer re-sample every cron trigger (#11427).
- Every sidebar navigation row is directly visible, without More or Customize sidebar (#11439).
- Agents know their microVM, which desktop a request refers to, and how to preserve an installation (#11443).
- Mobile schedules are now named Trigger (#11433).

### Fixed
- A Files folder that storage cannot mount no longer prevents a session from starting: the session starts without it, names the folder and why, and mounts it as soon as storage can (#11421, #11435).
- The home pillars band is even again, and the header switcher no longer covers Pricing (#11420).
- Opening Settings or Drive no longer shows a “Not found” toast (#11423).
- Boxes that wake before their session lease restore the session log (#11434).
- Unreleased Kortix in Chrome surfaces are disabled, preventing Chrome endpoint 404s (#11436).
- The daemon's Bun version matches lockfile v3 (#11437).
- A gateway request with no user or assistant message, or a malformed item, gets one 400 on every route (#11455).
- One Kortix skill list, so an agent may be granted kortix-chrome (#11453).
- Listing a folder in a session no longer restarts the session's daemon, so the next file action no longer fails with 503 (#11467).

### Security
- The account Files usage list shows only the projects the caller may read (#11435).

### Internal
- Stopped-computer disk is metered as storage but not charged; `KORTIX_BOX_DISK_CHARGE_ENABLED` stays off (#11435).
- Kortix's own Platinum cost for unattributed volumes and orphan boxes is recorded (#11435).
- Worker CPU is monitored with SNS alerts (#11452).
- The committed UI stylesheet is refreshed from component sources (#11449).
- pi summary fixtures and the session-log switch gaps follow the context record (#11447, #11448, #11457).
- apps-api cleanup sweep (#11454).
- The learnings index lists each entry once, matching its generator (#11424).
- Database script-private declarations stay local (#11429).
- Dev's version advances to 0.14.15 after 0.14.14 (88b3618).
- Boot guidance documents retrying a 401 when wake races the session lease (#11438).
- Goals is marked work in progress in Feature flags (#11441).
- Watcher App guidance specifies POST for /tick (#11442).
- Release-suite repairs: qualified box-disk subquery, Drive usage audit labels, `storage_charges` classified for purge and transfer, the billing Storage label in the UI catalog, billing tab tests, and a GOLD-1 prompt that leaves the commit to the host (#11461, #11465, #11472).
