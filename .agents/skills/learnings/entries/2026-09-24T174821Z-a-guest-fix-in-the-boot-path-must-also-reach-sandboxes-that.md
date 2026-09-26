---
recorded: 2026-09-24T17:48:21Z
incident_date: 2026-09-24
commit: 9fc6d53d12
---
# A guest fix in the boot path must also reach sandboxes that only resume

**Rule:** A change to a sandbox's boot path (Platinum `pt-init`, the image
entrypoint) never reaches a sandbox that resumes from a memory snapshot: it
must ship with a converge step that runs on restore. Fix a guest-OS default in
the layer that owns the guest (Platinum), not from the Kortix control plane.
Never stage bulk data in a sandbox's `/tmp`. A step that moves files under
running processes must refuse on sockets and locks held there.
**Incident:** 2 of 17 active 4 GiB prod sandboxes had a RAM-backed `/tmp` full
(1.96 GiB: abandoned legacy-transfer uploads 8 days old, agent virtualenvs);
the memory guard stopped their turns on every command. A first live remount
started a second Platinum keepalive through a copied, unlocked `pt-ka.lock`.
**Enforcers:** Platinum `infra/test/guest-tmp-on-disk.test.sh`,
`infra/test/pt-tmp-migrate.test.sh` (byte parity with the host-agent copy),
`guest_tmp_test.go`; kortixd `resources.test.ts` names RAM-backed files in the
guard's stop reason.
