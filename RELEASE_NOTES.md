Entitlement overrides, act-as support sessions, and one-call agent secret grants

## New

- **Act-as for support** — platform admins can open a customer account for up to one hour, with a visible banner and full auditing. Anything that would outlive the hour — tokens, memberships, invites, SSO providers, public shares, tunnels, agent scope changes — is refused during the session.
- **Per-account entitlement overrides** — operators grant or extend individual entitlements per account, each with an optional expiry, from a new admin override console. Expired overrides stop applying on their own.
- **One plan catalog** — plans now resolve through a single catalog and resolver across API, SDK and web. The duplicate frontend tier catalogs and the "· legacy" plan label are gone.
- **Grant a secret to an agent in one call** — a new API route grants an agent access to a secret, and the web app offers that grant directly from the warning that reports the missing access.
- **Session overrides in one place** — the Scope panel is replaced by a single overrides popover: agent, model, sandbox and connector overrides together, labels grounded in the agent's real defaults, and a reset that is always reachable.
- **Managed model lineup refresh** — Muse Spark 1.2, MiniMax M3 and GPT-5.6 Luna join GLM 5.2, and DeepSeek V4 Flash becomes the platform default.
- **Sandboxes stay current** — every deploy serves its CLI and managed skills at `/v1/runtime-assets`, and sandboxes reconcile against it on start, restart and resume.

## Improved

- Project sessions are grouped by last activity instead of creation date.
- Account settings are reachable from the user menu.
- Model errors keep their upstream cause through gateway fallbacks, and context overflow is reported consistently — including after a fallback.
- Managed-model capabilities reported by the gateway now come from real pricing data.
- An outdated CLI now gets a clear "update your CLI" warning on the connector routes instead of a raw 404.

## Fixed

- Two ways the session message queue could stall.
- Saving session scope without touching connectors no longer writes a connector override, and a saved agent secret selection is retained.
- Secret delivery on Platinum sandboxes resolves replicas reliably and arms the secrecy boundary within the provider's real timing budget, without re-arming on every turn.

## Security and compliance

- The impersonation deny-list also covers agent-governance writes (`agents/:name/scope`, `secrets/:id/grant`), connector and channel management, and setup-link minting — all closed during review, before release.
- MFA enforcement for IAM users, WAF attached to the web load balancers, load-balancer log bucket versioning, and a tightly scoped CI Terraform role.

## Internal

- Terraform for dev and prod now applies from CI behind per-environment OIDC roles, with drift detection re-registered.
- Production deploys stamp the frontend with the release version and no longer allow mixed frontend/API states; migrations with blocking backfills are rejected at lint time.
- Full-stack PR previews run in warm sandboxes, and the local test gates were stabilized.
