Self-hosting: one generic Docker deployment, VPS-first

## Self-hosting, rebuilt

One generic Docker Compose self-host that runs the full Kortix platform on any VPS/server — `kortix self-host init` + `start`, VPS-first with a persistent domain (Caddy + automatic TLS), plus Cloudflare-tunnel and local modes for evaluation.

- **In-app GitHub setup** — create an org-owned GitHub App from Settings → Git (manifest flow), paste an existing App, or use a scoped access token. No CLI gymnastics, no PATs required.
- **Self-host feature flags** — single-account mode, marketing site off by default, enterprise license unlock, billing/connectors gracefully hidden when unconfigured.
- **Operations built in** — nightly zero-downtime rolling updates on the curated `stable` channel (promoted via the new Promote Self-Host Stable workflow), `kortix self-host secrets` management, run-any-version + local-images modes, required-secret enforcement at init.
- **Kortix-managed models are cloud-only** — self-host deployments use your own model keys (BYOK); the managed catalog is gated behind an explicit flag.
- **Reliability** — SSE turn-stream no longer leaks connections on retry (fixes tab-wide request starvation); stale sessions self-heal instead of dead-ending on the auth screen.
- New self-host e2e test suite (fast CLI-artifact tier + opt-in live tier) wired into CI.
