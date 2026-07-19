Reliable session starts + re-shipped LLM gateway

This release fixes the session-start regression behind the v0.10.11 rollback and re-ships the rebuilt LLM gateway.

### Fixed
- New sessions could hang at "Starting the agent" and never become ready — the in-sandbox runtime was rejecting its own model configuration. Sessions now start reliably.
- Sandbox images re-downloaded the browser engine on rebuilds, which slowed session startup under load; the browser layer is now cached deterministically.
- Slack channels showing "Not connected" with no connector available.

### Improved
- The LLM gateway is rebuilt on the Vercel AI SDK with a live models.dev catalog (re-shipped from 0.10.11).
- Broader end-to-end test coverage and infrastructure monitoring.

### Internal
- Groundwork for an alternate managed-git backend (off by default; deployments stay on GitHub).
- Secrets-management hardening.
