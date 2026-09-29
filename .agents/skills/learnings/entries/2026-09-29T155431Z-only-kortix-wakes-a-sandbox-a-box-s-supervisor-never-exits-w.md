---
recorded: 2026-09-29T15:54:31Z
incident_date: 2026-09-28
---
# Only Kortix wakes a sandbox; a box's supervisor never exits where its init will not relaunch it

**Rule:** Three rules.

1. A provider-side mechanism that can start a Kortix box is off. Platinum session boxes are created with `auto_resume: false`, and `stop()` turns it off on older boxes.
2. On Platinum, `entrypoint.sh` relaunches the daemon on every exit. `pt-init` launches it once and never again.
3. When a running box's daemon stays silent, `/start` relaunches it before it parks the box. Parking only freezes the corpse into the snapshot that every later wake resumes.

**Trigger surface:** Any of these changes:

- Adding a provider, or a provider flag that starts, resumes or wakes a VM.
- Any code that dials a box's ingress: proxy, probes, sweeps, retries.
- Editing the supervisor loop in `apps/sandbox/entrypoint.sh`.
- Changing what `/start` does with a provider-running box whose runtime is unreachable.

**Incident:** 2026-09-28 → 29, prod, one session unusable for 18 h.

1. The idle reaper stopped the row and the VM, which revoked the box's session token.
2. 38 s later, Platinum's edge auto-resumed the VM on an inbound request that Kortix had not authorized.
3. The v0.13.39 daemon's dead-token breaker exited 0.
4. The entrypoint exited, and `pt-init` never relaunched it. Every later `/start` resumed a snapshot with nothing on :8000, parked it (`runtime_boot_failed`), and cooled down.

Other measurements:

- Platinum audit: every Kortix stop of that box on 2026-09-29 was followed 2–26 s later by an unrequested start.
- A controlled probe on prod Platinum: one GET to an archived box's edge URL returned it to `running` in 36 s.
- 68 prod boxes were closed by the row↔VM divergence sweep in the first 24 h after it shipped.
- The daemon's exit was already removed in #7861 (v0.13.41). Boxes built before it keep it until repaired.
- Recovery: `legacy-runtime-sweep.ts --session <id> --force` while the VM runs.

**Enforcement:**

- `platinum-create-dedup.test.ts` ("only Kortix wakes a session box") asserts `auto_resume: false` on create.
- `platinum-stop-confirm.test.ts` asserts that stop turns it off only on a Platinum that reports the field.
- `e2e-project-session-contract.test.ts` ("relaunches a dead daemon on a running Platinum box instead of parking it") covers the `/start` repair.
- `legacy-runtime-bootstrap.test.ts` (`decideDeadDaemonOnOpen`) covers the open-path decision.
- The entrypoint relaunch has no unit test. It was verified on a real Platinum VM: SIGTERM → exit 0 → relaunched, :8000 `200`. The old entrypoint exited and :8000 stayed dead.
