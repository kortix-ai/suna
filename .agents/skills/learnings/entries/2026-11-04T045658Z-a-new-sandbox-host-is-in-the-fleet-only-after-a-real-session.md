---
recorded: 2026-11-04T04:56:58Z
incident_date: 2026-11-04
---
# A new sandbox host is in the fleet only after a real session ran on it; ready and reachable prove nothing

**Rule:** Do not count a new Platinum host as capacity until a real Kortix session has run a command on it. After the install, check every gate the scheduler applies, not only `state` and `proxy_reachable`: `vol_v` equal to the fleet, the host kernel (`uname -r`) and the staged guest kernel equal to the fleet's pinned kernel, warm snapshots present (`metadata.snapshotTemplates`). Then migrate one internal session onto the host and prompt it. The runbook is the Platinum skill `compute-buying`, `references/scaleway-host-onboarding.md`.

**Trigger surface:** Buying, installing, reinstalling or re-imaging a sandbox host; reading "ready" on the Platinum admin hosts page or a capacity plan whose supply just rose; raising org pools on the strength of new supply.

**Incident:** 2026-11-04. A new 64-core / 566 GB host was bought to relieve a capacity cap, and the capacity plan counted it at once (+30% placeable RAM). It reached `ready` at 03:40 UTC and took no work until 04:50 UTC. Four gates kept it out, found one after another:
1. The CP rejected its RPC cert: `install.sh` did not persist the exported private IP.
2. The `:18048` firewall dropped the CP's private-network probe.
3. `vol_v` was 0: `install.sh` does not ship the volume helper, and only a host roll does.
4. The host kernel and the staged guest kernel were 6.8.0-146 against the fleet's 6.8.0-88. Ubuntu had dropped 6.8.0-88 from apt, and the pin script silently fell back to the running kernel. The scheduler's guest-kernel gate refused the host every template.

Each gate looked healthy from the dashboard. The org pools had been raised against the new supply in the meantime, so for that hour committed pools exceeded what the fleet could place. Fixed in Platinum PRs #2614, #2618 and #2621 (installer, kernel pin, firewall). Proof: an internal session migrated onto the host ran `uname -r` through the agent.

**Enforcement:** Partial. Guard tests in Platinum `apps/api/src/installAddressAndBoot.guards.test.ts` cover the private IP in `host.env`, the GRUB-pinned guest kernel, and the CP private IP allowlist. `pin-host-kernel.sh` now fetches the pinned kernel from Launchpad. None yet: a host self-check that turns `ready` into `ready-but-unplaceable` when its guest kernel or `vol_v` differs from the pool's, shown on the admin hosts page and excluded from capacity-plan supply.
