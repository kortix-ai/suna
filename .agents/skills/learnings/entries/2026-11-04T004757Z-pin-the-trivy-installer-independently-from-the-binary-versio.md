---
recorded: 2026-11-04T00:47:57Z
incident_date: 2026-11-04
---
# Pin the Trivy installer independently from the binary version

**Rule:** Pin and verify the installer as well as the binary. Changing the binary version does not change setup-trivy's pinned installer. Use the GitHub Releases installer until get.trivy.dev resolves again.

**Trigger surface:** Trivy installation in deploy-dev.yml, ci.yml and security-scan.yml.

**Incident:** 2026-11-04, Deploy Dev run 41742751837. setup-trivy exited 6 because get.trivy.dev did not resolve. The scan never ran, although application deployments succeeded. The historical installer installs the same v0.70.0 binary from GitHub Releases and verifies its archive checksum.

**Enforcement:** tests/unit/install-trivy.test.ts runs the real installer and rejects a modified installer download. The root unit lane discovers this .test.ts file through tests/unit/vitest.config.ts. Workflow scans retain their existing failure policies.
