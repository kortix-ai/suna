Audit log, session costs, session scope controls, and a rebuilt kortix.com

## New

- **Audit log** — every API request and agent action lands in one centralized audit trail. The app gets a project and session audit explorer; the SDK gets reconstruction filters and client attribution.
- **Session costs** — one unified cost record per session, and a session cost explorer in billing that shows what each session spent.
- **Session scope controls** — new sessions can start with an explicit, opt-in scope over connectors and secrets. Agents can require connector profiles, connector profiles carry an authorization strategy, and denied secrets never enter the sandbox. When a required connector is missing, the session prompts to connect it instead of failing.
- **Answerable approvals** — approval prompts show the full tool arguments, and approval policies match on arguments, not just tool names.
- **Automatic session titles** — sessions are titled from the first prompt, server-side, on every session-start path.
- **Signup lands in a project** — new accounts go straight into a working project, with no blocking provisioning step.
- **Microsoft Teams (experimental)** — Teams is available as a per-project experimental channel.
- **Embedding Kortix** — per-end-user session caps enforced on create and resume, hardened sandbox isolation between end users, and mid-session re-scoping of secrets and connector bindings.
- **New website** — kortix.com rebuilt: home page, Solutions, Security, Self-hosted, Integrations, Channels, Automations, About, Careers, and a public /download page. An accuracy sweep removed claims that were not true and corrected public pricing copy.

## Improved

- The project Files route opens instantly instead of after 5–6 seconds, session transcripts paint from cache instead of waiting on the sandbox VM, the sidebar no longer flickers on cold load, and older history loads by scrolling.
- Sandboxes have a bounded lifetime that a wedged box cannot escape, and compute is billed against liveness evidence, never wall-clock.
- Billing is one state machine: running out of credits reads as "out of credits", never "no plan"; one credit-debit function with no wallet-floor bypass; Stripe checkout returns work from any route.
- Sessions order by last activity, connector profile creation is atomic, and the icon set moved to Phosphor.
- Managed models group under Kortix in the model picker instead of being split across upstream provider names.

## Fixed

- Gateway: Bedrock adaptive thinking and region-prefix normalization, and the correct base path for standalone OpenAI keys.
- A broken sandbox template no longer fails the whole template listing.
- Public file-share links restored across the file and preview surfaces.
- Signup and sign-in redirects can no longer land in a project the user cannot open.
- Opening a session with history no longer shows an empty new-session shell, and triggers show as active when they are active.
- CLI: private and self-hosted API hosts are no longer forced to https, and IPv6 hosts classify correctly.
- Every /docs route returned 500 after an icon namespace crossed the RSC boundary.
- Closed public SSH/RDP exposure on a network ACL and added an audit that keeps it closed.
