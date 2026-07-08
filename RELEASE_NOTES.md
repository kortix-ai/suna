Marketplace 1-click imports, groups and custom roles for every plan, and a sandbox that recovers when a build fails

## New

- **Marketplace imports.** Agents, commands and bundles install into a project in one click. The detail view now shows what a listing actually contains — bundle contents, capability badges, type-aware copy — before you add it.
- **Groups and custom roles on every plan.** Previously limited by tier; now available to all accounts.
- **Answer permission prompts from the CLI.** Sessions that pause for approval can be resolved without leaving the terminal.
- **One-click Slack connect** via `kortix channels connect` — no manual app setup.
- **Review center approvals.** Approve and deny executor requests for real, with change descriptions rendered as markdown.
- **OAuth1 connectors** for OpenAPI and HTTP.
- **Always-bound project CLI.** `login` binds a default project; unbound commands recover interactively instead of failing.

## Improved

- `kortix.toml` is now `kortix.yaml` (TOML stays supported as v1 legacy), with format-aware manifest errors and agent-scope/trigger-path parity.
- Destructive actions are confirm-gated: deleting secrets, revoking gateway keys, deleting sandbox templates and sessions, archiving projects.
- Loading states unified across the app; onboarding moves Skip into the footer per step.
- Upgrades are surfaced with an accent card and a Recommended badge.
- A complete IAM administrator's guide: SSO/SAML, SCIM, roles, groups, custom roles, agents, audit.

## Fixed

- **Sessions on projects pinned to the Platinum sandbox provider could not start.** Production's `sandbox_provider` type was missing the `platinum` value, so every session create failed at the database. The value is now added; a sandbox that fails to start also raises properly so provisioning retries.
- **Retry build / Fix with agent** works again, snapshot quota cleanup can fire, and the prewarm cache is bounded with an alarm when cleanup falls behind.
- **Permission leaks closed.** Project detail sections are filtered by read capability, previously ungated project endpoints now check their capability leaf, member management gates on the leaf rather than a broad write floor, and viewers no longer see error toasts for surfaces they cannot read. Read-only users get a degraded view instead of a broken one, and the floor member role can fire triggers again.
- Service-account bearer tokens are accepted wherever user tokens are.
- Unknown CLI commands now error with a suggestion instead of silently scaffolding a project named after the typo.
- The model picker updates immediately after connecting a provider, and setup links render as clean CTA chips rather than raw token URLs.
- Resolved high-severity CodeQL findings (ReDoS, temp-file handling, TOCTOU, CLI opener).
- Rename dialogs no longer close mid-save; sessions and projects show honest error, empty and retry states.
