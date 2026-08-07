Secret delivery controls, unified connectors, and flat credit plans

Secret delivery is now a managed control plane, connectors speak one language across the whole platform, and billing moves to flat credit plans.

### New

- **Secret delivery controls.** Decide exactly which secrets each agent session can use. Policies are managed from the web app and CLI, secrets reach sandboxes through an audited HTTPS broker with session-scoped handles, revoked secrets disappear from running agents, and LLM, connector, git, and subscription credentials are isolated from each other. A new `kortix audit` CLI command reads the account audit trail.
- **Unified connectors.** One connector model across web, CLI, SDK, and API: consistent Connector and Connection terminology, a single data plane in `@kortix/sdk`, and connector credentials that bind to project secrets. The connector catalogue now pages through the full ~2,700-app list instead of stopping at 192.
- **Flat credit plans.** Plans are priced as flat monthly credits instead of per-seat pricing. Billing also gained idempotent compute debits and accurate spend reporting.
- **Rebuilt project onboarding.** A single-column, seven-step flow with a clearer Slack setup and plan selection.
- **Capability pages.** Connectors, skills, and agents are browsable pages instead of a configuration overlay.
- **Use-case packs.** Marketplace runbooks are grouped into installable packs, with real loading and error states and inline project creation.
- **Document conversion by default.** Every new sandbox includes a convert-documents-to-markdown skill backed by a baked-in converter.
- **Serverless app deployments.** Provider-neutral serverless deployments for apps, served behind a managed edge with wildcard TLS and signed public hosts.
- **Kimi K3** is available as a managed model.

### Improved

- **Sessions survive interruptions.** A pending agent question is parked when its sandbox dies and restored on the next boot, and a stored answer is delivered as a follow-up turn. Runtime updates boot and verify the new runtime before retiring the old one.
- **Chat UX.** Instant session rename, a truthful header title, idempotent provisioning, preview verdicts, and grouped activity. In-flight sends survive navigation, and tool failures are reported honestly.
- **Session list.** Rebuilt with status states, collapsible sections, and a nested filter menu.
- **Faster, calmer navigation.** Project pages load faster (Next.js 16.3), and passively opening a project no longer wakes idle sandboxes.
- **Clearer errors.** The LLM gateway surfaces real upstream provider errors instead of a generic Bad Gateway, and large repository branch listings are bounded.

### Fixed

- Billing: the same compute window can no longer be charged twice, "spend this period" reports the correct window, the paid seat is released when SCIM deprovisions a member, BYOK failover respects the managed-model entitlement, and the UI shows the concurrency limit the server actually enforces.
- Agent workspaces are strictly enforced across repository, git, and clone APIs.
- Approvals require a full review of each call, and the daemon no longer auto-answers questions outside a channel session.
- The Terms of Service link opens the document directly.
- Desktop: the title bar aligns with the OS window controls.
- Production API recovery is hardened: migration-safe restarts and better behavior under memory pressure.
