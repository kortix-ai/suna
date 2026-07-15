Self-host: verified laptop and VPS deployments, guided setup

## Self-host hardening — everything live-verified

- **Agent sessions work everywhere**: fixed the LLM base URL handed to cloud sandboxes and the in-API gateway path shape — BYOK model keys now carry real agent turns on local machines (Cloudflare tunnel) and VPS (domain) alike, proven end-to-end.
- **Guided setup, VPS-first**: `kortix self-host init` walks domain/reachability → admin email → deployment shape → sandbox provider (Daytona/E2B/Platinum) → optional connectors → update schedule. Help text cut to a page. Auto-update on by default.
- **GitHub connection hardening**: personal-account installs route correctly, torn configs are detected, the Git settings tab never renders blank, and 'New project' takes you to Git settings when GitHub isn't connected yet.
- **CLI against your self-host**: `kortix login` opens your deployment's dashboard and the full login → projects → ship flow is verified.
- **kortix-selfhost/**: one-README distribution with an optional thin Terraform for AWS/EC2 — durable data volume, automatic EBS-snapshot backups (configurable cadence, keeps N), DNS via Route53 or your own provider.
