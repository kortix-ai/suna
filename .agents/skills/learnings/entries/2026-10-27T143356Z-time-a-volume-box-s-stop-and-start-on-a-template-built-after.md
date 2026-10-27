---
recorded: 2026-10-27T14:33:56Z
incident_date: 2026-10-23
---
# Time a volume box's stop and start on a template built after the latest Platinum host roll before turning workspace_volume on

**Rule:** Before you turn `workspace_volume` on for a project, and after every Platinum host roll while it is on, build a new template and time stop → start of a box with a private volume. The bar is about 2 s, with `/workspace` mounted and its files intact. A Platinum in-VM agent change reaches a box only through a template built after the host roll. A box from an older template still runs the old agent, so it hides the change.

**Trigger surface:** Turning `workspace_volume` on for a project. A Platinum production host roll (`deploy-hosts.yml` in the Platinum repo). A change to `apps/api/src/platform/services/workspace-volume.ts` or to the stop and start paths of a volume session.

**Incident:** 2026-10-23, found by the bench for #10846. Platinum #1784 (in the 2026-10-21 production host roll) added a filesystem grow to the in-VM agent's idempotent `vol_mount`. After a memory restore, the Platinum host sends `vol_mount` before it thaws the freeze from the stop. The grow waited on the frozen filesystem. On every template built after the roll, a start of a stopped box with a volume took 44.6–47.4 s (n=12), not 0.8–3.3 s (n=9). On a plain Ubuntu image, `/workspace` was not mounted after the start (3 of 3). Kortix impact: none. The flag was off on every project. Fixed in Platinum #1912 (`011ab12bb`), on Platinum production hosts 2026-10-27 02:51–03:05 UTC. After the roll, on production: 1.45–1.81 s on a new Ubuntu template, 1.54–1.55 s on the Kortix default template (n=3 each), mount and files intact. On dev Kortix with the flag on, `/start` of a stopped session reached runtime ready in 3.17–3.21 s on the same box (n=3), with files and conversation kept.

**Enforcement:** none yet: the hourly session canary (#10927) never stops and starts a `workspace_volume` session. The enforcer to build is one stop → start step on a `workspace_volume` project in that canary, with an alert above 5 s or when `/workspace` is not a mount point.
