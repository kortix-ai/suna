Rebuilt site, per-project audit trails, session costs, and connector authorization

Kortix v0.12.0 brings a rebuilt marketing site, a full audit trail for every project and session, per-session cost tracking, connector authorization controls, and a faster path from signup into your first project — plus a batch of billing, gateway, and self-host fixes.

## New

- **Audit log for every project and session.** Every API route is now labeled and recorded as a structured audit event. A new audit explorer in the web app lets you reconstruct what happened in a project or session, filter by action, and see who did what. Execution summaries are redacted before storage.
- **Per-session cost tracking.** Sessions now carry unified cost records. A session cost explorer shows spend per session, and the SDK exposes the cost records directly.
- **Connector authorization controls.** Connectors now have an explicit authorization owner and an authorization strategy that is enforced when a connector is linked and again before a session starts. A session can require specific connectors, and the app guides you to connect a missing one instead of failing blind. Profile creation is atomic.
- **Straight into a project on signup.** New signups now land directly in a working project, with no blocking provisioning step in the way.
- **Session titles from the first prompt.** New sessions are named automatically from your first message, generated server-side through the model gateway.
- **Rebuilt marketing site.** New home page, About, Careers, and a Company menu; Solutions pages for each role; and grounded /integrations, /security, and /self-hosted pages. Recorded CLI hero videos in both light and dark themes, a collapsing FAQ, a design-system index, downloadable wallpapers, and a public /download page. Copy was corrected end to end — false claims removed and a public price that was 2x wrong fixed.

## Improved

- **Billing is one state machine.** "Out of credits" is no longer mislabeled as "no plan"; a single credit-debit path removes a wallet-floor bypass; and compute is billed against real liveness evidence rather than wall-clock time. The usage breakdown now reads the same ledger the billing RPCs write.
- **Managed models group under Kortix** in the model picker, instead of being split across Anthropic and DeepSeek.
- **Sandboxes have a bounded lifetime** enforced by a server-owned deadline the box cannot forge.
- **Secrets delivery chokepoint** — a denied secret never reaches the sandbox.
- **Approvals are answerable and enforced on arguments**, so an approval gate checks what a tool was actually asked to do.

## Fixed

- **Bedrock on self-host.** Extended thinking now uses the adaptive format current Claude models require (high-effort turns no longer 400), and a model id with the wrong region prefix is normalized to the deployment's region instead of failing with "invalid model identifier."
- **Auth redirects.** Sign-in no longer returns you to the projects list, and a signup is never sent to a project it cannot open.
- **Broken sandbox templates** are skipped gracefully instead of failing the whole template listing.
- **/docs no longer 500s** (an icon namespace crossing the server-component boundary).
- **Self-host CLI** reaches its API over container names and LAN addresses again — private hosts are classified correctly and no longer forced onto https.
- **Gateway** soft rate limits require zero usage, and the standalone OpenAI base path is corrected.
- The install greeting no longer prints a retired category line, and browser-extension console noise is suppressed.
