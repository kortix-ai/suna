---
recorded: 2026-09-28T17:40:17Z
incident_date: 2026-09-28
---
# Request a sandbox's kernel capabilities at template build; a session cannot load modules its rootfs does not carry

**Rule:** When a sandbox needs a kernel feature (Docker bridge/overlay/netfilter, FUSE variants, any `.ko`), request it on the template: kortix.yaml `container_runtime: true` → Platinum `kernel_modules: container` on `/v1/templates/from-build`. Do not try to repair it inside the session, and do not fall back to `--bridge=none --storage-driver=vfs`. A new provider build option must be echoed by the provider and checked, because an older API strips unknown fields silently. On a missing echo, warn in the build log and keep building: Platinum cannot cancel a queued build (`DELETE` answers `409 build_in_progress`), so failing the build leaks one full build per attempt.

**Trigger surface:** Adding a sandbox capability that depends on the guest kernel; adding a field to a Platinum `/v1/templates/*` request; debugging `dockerd` inside a session.

**Incident:** 2026-09-28. Engineering sessions on a Platinum template could not run `pnpm worktree start`, `supabase start`, or `pnpm test`: `dockerd` failed with `iptables: Failed to initialize nft: Protocol not supported`, and `--iptables=false` then failed on the default bridge. `/proc/modules` had 4 lines and `/lib/modules/<release>/kernel/net/bridge` was absent. Root cause: Kortix builds every template through `/v1/templates/from-build`, which could not request the `container` module profile that `/from-spec` already had (Platinum #545). A probe on Platinum Development proved that the profile plus `kmod` is enough: the guest kernel autoloads bridge, nf_tables, veth, and overlay for a flagless `dockerd`. Fix: Platinum #1326 (`kernel_modules` on from-build, echoed) and the Kortix `container_runtime` template option.

**Enforcement:** `apps/api/src/snapshots/providers/platinum-container-runtime.test.ts` fails when the provider stops sending `kernel_modules` or stops warning on a missing echo. `apps/api/src/__tests__/unit-dockerfile-layer.test.ts` → `container_runtime` fails when the layer stops installing `kmod` or marking the image. `apps/api/src/__tests__/unit-snapshot-hash.test.ts` fails when the flag stops moving the snapshot identity.
