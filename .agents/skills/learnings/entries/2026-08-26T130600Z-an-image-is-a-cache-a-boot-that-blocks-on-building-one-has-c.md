---
recorded: 2026-08-26T13:06:00Z
incident_date: 2026-08-26
commit: 97b81a45d1
---
# An image is a cache; a boot that blocks on building one has confused it for the truth

**When:** touching `ensureSandboxImage` or any boot-path call that can reach a
provider build. Every `self-host update` bumps the runtime fingerprint and
starts a template rebuild (14 m 11 s measured); session starts inside that
window sat in `provisioning` for 10–34 minutes, polling the in-flight build for
up to 12 minutes or building inline. The daemon converges on the deploy's
runtime assets at boot and on every resume, so a box booted from the previous
ready image serves the same CLI, skills and OpenCode pin. Rule: **a session boot
serves the last image its template lineage actually shipped and lets the new one
bake behind it; only a genuinely FIRST build may block.** Bound the fallback to
the same lineage, same provider, recent — convergence does not rebuild the base
rootfs. *Enforcer:* `last-ready-image.test.ts` (predecessor served while the new
identity builds; first build still blocks) and `e2b.test.ts` (a resume never
consults a template at all).
