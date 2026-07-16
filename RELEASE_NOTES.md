Self-host hardening, experimental local-docker sandboxes, and an auth refresh fix

Self-host hardening wave from the production-readiness audit, an experimental local-docker sandbox provider, and an auth refresh fix.

**New**
- **Experimental local-docker sandbox provider for self-host** — run agent sandboxes as plain Docker containers on the same machine as your Kortix instance, with no cloud sandbox account. All sandbox-facing URLs resolve over the Docker network. Listed last in the provider picker and not recommended for production: it builds sandbox images locally and is noticeably slower than Daytona or Platinum.
- **Moving `dev` / `staging` / `prod` image tags** — self-host instances can now track a channel-style tag (`kortix self-host init --tag dev|staging|prod`); CI re-tags the deployed build by digest, no rebuild.
- **Smoother SSO/SCIM setup** — mint the SCIM token and paste it into your IdP on one page, live SSO verification with a resume story, complete Directory Sync and Google guide screenshots, and a visible "Use single sign-on (SSO)" entry on the sign-in page.

**Improved**
- **Self-host updater** — resilient update runs with visible outcomes (`kortix self-host status` now shows the last update result), rotated container logs, and per-service memory limits so one service can't starve the box.
- **Self-host EC2 (Terraform)** — the data volume now survives instance replacement (AZ pinned to the subnet, not the instance), reboot-surviving bootstrap, containerd relocated to the data volume, and CloudWatch status/disk/memory alarms.
- **Zero-downtime migration policy** — every new database migration is linted by squawk plus deterministic mixed-version and enum-value guards in CI, with a rewritten migrations runbook.

**Fixed**
- **Silent auth refresh** — sessions renew in the background; an expired token no longer leaves a dead, blank page.
- **Git PAT import** — a saved managed-git personal access token is now recognized as a connected GitHub account, so repo import works without reconnecting.
- SCIM Tenant URL is now correct on same-origin and self-hosted deployments.
- Removed the legacy `SANDBOX_IMAGE` configuration surface from self-host.
- Scoped the ECS deploy role's describe/list IAM actions to Kortix ARNs.
