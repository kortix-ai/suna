---
recorded: 2026-09-18T19:11:33Z
incident_date: 2026-09-18
commit: 6b86a67cbb
---
# Verify scoped NAS identity with a fresh sandbox boot

**Rule:** When copying NAS secrets across projects, select a project-specific
SSH user and key before validating mounts. Check the remote account's allowed
shares and read `/tmp/nas-mount.status` after a fresh sandbox boot. A present
secret and a successful SSH login do not prove every selected share mounted.
**Near-miss:** one of two requested mounts failed because the sandbox used the
source project's default NAS account. **Enforcer:** none; add a boot check for
every selected share to the project cutover procedure.
