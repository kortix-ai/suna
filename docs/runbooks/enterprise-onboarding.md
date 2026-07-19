# Enterprise onboarding packet — self-hosted Kortix

> Customer-facing checklist for onboarding a new enterprise account onto a
> self-hosted Kortix deployment. Derived from `docs/runbooks/self-hosting.md`
> (operator mechanics) + `docs/ENTERPRISE_EDITION.md` (entitlements). Mirrors
> the FDE white-glove motion in goal §5 (invest the first 3–4 hours per
> company: integrations connected, Slack installed, set up and customized to
> THEIR company).
>
> This is the generic template — fill in the per-customer specifics (domain,
> IdP, sandbox provider, point of contact) at the start of each engagement.

## What the customer provides (before the onboarding call)

| # | Item | Why | Notes |
|---|---|---|---|
| 1 | **A VPS or cloud VM** (recommended) with Docker Engine + Compose plugin installed | Kortix self-host is one generic Docker Compose system; runs on any Linux VPS, EC2, Droplet, bare metal | Minimum: 4 vCPU / 8 GB RAM / 50 GB disk for evaluation; size up for production. `scripts/kortix-selfhost-up.sh` installs Docker on a fresh Linux box. |
| 2 | **A public domain** pointed at the box's public IP (A/AAAA records for `<domain>` + `api.<domain>`) | Turns on the bundled Caddy reverse proxy + ACME TLS; required for agent sandboxes to call back to the API | No domain = Cloudflare tunnel fallback (ephemeral URL, evaluation only, not production). |
| 3 | **A sandbox provider API key** — Daytona (default), Platinum, or E2B | Agent sessions run in cloud sandbox VMs outside the customer's network; they call back to the Kortix API over the public internet | Daytona is the recommended default. `local-docker` is experimental, not for production. |
| 4 | **Managed-git credentials** — a GitHub PAT or GitHub App | The platform creates project repos under the customer's org | `MANAGED_GIT_PROVIDER=github` + `MANAGED_GIT_GITHUB_TOKEN` + `MANAGED_GIT_GITHUB_OWNER`. |
| 5 | **(Optional) SMTP credentials** — host/port/user/pass, admin sender | Enables magic-link sign-in + email verification; fresh installs auto-confirm signups and lead with password auth, so SMTP can come later | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME`. |
| 6 | **(Enterprise) IdP metadata** — Entra ID / Okta / Google / custom SAML | SAML SSO + SCIM (group→role mapping, automated user provisioning). SAML capability is on by default; the enterprise IAM surface unlocks with the entitlement | See `docs/ENTRA_SSO_SCIM_SETUP.md` for the full walkthrough. |
| 7 | **(Enterprise) License entitlement** — issued by Kortix sales | Unlocks SSO/SCIM/RBAC/audit (hidden behind 402 without it) | `ENTERPRISE_LICENSE_AVAILABLE=true` (or `--enterprise-license` at `init`). |

## What we do (the 3–4 hour white-glove setup)

### Phase 1 — Provision + reachability (~45 min)

1. **Provision the box.** SSH in; run `bash <(curl -fsSL https://raw.githubusercontent.com/kortix-ai/suna/main/scripts/kortix-selfhost-up.sh) --domain <domain> --email ops@<domain>`. This installs Docker, runs `kortix self-host init`, and starts the stack.
2. **Verify reachability.** `curl https://api.<domain>/v1/health` → expect `{"status":"ok","environment":"prod","version":"<version>"}`. `curl https://<domain>` → expect the Kortix frontend.
3. **Verify TLS.** Caddy obtains ACME certs automatically (DNS-01 via Route53 on AWS, HTTP-01 elsewhere); confirm a valid cert in the browser.

### Phase 2 — Sandbox + managed-git (~30 min)

4. **Configure the sandbox provider.** `kortix self-host env set DAYTONA_API_KEY=... DAYTONA_SERVER_URL=https://app.daytona.io/api DAYTONA_TARGET=us` → `kortix self-host start`.
5. **Configure managed-git.** `kortix self-host env set MANAGED_GIT_PROVIDER=github MANAGED_GIT_GITHUB_TOKEN=... MANAGED_GIT_GITHUB_OWNER=<customer-org>` → `kortix self-host start`.
6. **End-to-end smoke test.** Create a project → start a session → run one agent turn. The agent must complete against the configured LLM provider (no OpenRouter dependency for managed Claude models on AWS — Bedrock via instance role).

### Phase 3 — Enterprise identity + governance (~45 min)

7. **Unlock the enterprise entitlement.** `kortix self-host env set ENTERPRISE_LICENSE_AVAILABLE=true` → `kortix self-host start`.
8. **Register the IdP.** Self-serve path (recommended): sign in as account owner → Account → Settings → Identity → SAML SSO → Configure → Import IdP metadata. Kortix registers the IdP with the self-hosted Supabase Auth server-side — the customer never touches Supabase directly. Entity ID / ACS URL / metadata endpoint are all derived from the customer's own `KORTIX_DOMAIN`.
9. **Configure SCIM** (group→role mapping, automated provisioning). Same dashboard surface; see `docs/ENTRA_SSO_SCIM_SETUP.md`.
10. **Verify SSO.** Sign in via the IdP (not password) as a test user; confirm group→role mapping applies correctly.

### Phase 4 — Customization + handoff (~60 min)

11. **Connect integrations.** `kortix self-host configure` (interactive) or `kortix self-host env set ...` for Pipedream connectors (optional), SMTP (if provided), and any customer-specific LLM provider keys.
12. **Restrict account creation** (enterprise default). `kortix self-host env set KORTIX_RESTRICT_ACCOUNT_CREATION=true KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION=true` → `kortix self-host start`. (New signups only via SSO/SCIM after this.)
13. **Backups.** Configure a backup cadence + `.env` vault per the Backup & DR (enterprise) section of `docs/runbooks/self-hosting.md`. **Run the restore drill once before going live** — an untested backup is a liability.
14. **Auto-updater policy.** Default: `stable` channel, daily auto-update. For enterprise: consider `KORTIX_AUTO_UPDATE=false` + a planned maintenance window for controlled updates (curate via the `Promote Self-Host Stable` workflow). State the RPO/RTO explicitly.
15. **Handoff.** Walk the customer's operator through `kortix self-host` CLI surface (`init`/`doctor`/`status`/`update`/`rollback`/`env`/`logs`/`configure`), the runbook (`docs/runbooks/self-hosting.md`), and the support path.

## Success criteria (certification checklist)

- [ ] `terraform apply` or bootstrap script clean from scratch (no errors)
- [ ] All containers healthy (`kortix self-host status`); migrate exit 0
- [ ] Supabase authenticated health through Kong
- [ ] API `/v1/health` 200 with expected version; frontend 200; TLS valid
- [ ] Sign-up/sign-in + one real project/session flow persists data
- [ ] One agent turn completes against the configured LLM provider (no OpenRouter fallback for managed Claude on AWS)
- [ ] SSO sign-in works via the customer's IdP (not password); group→role mapping correct
- [ ] SCIM provisioning creates a test user with the right role
- [ ] Auto-updater timer ran once and no-oped cleanly (or `KORTIX_AUTO_UPDATE=false` + documented maintenance window)
- [ ] Backup recovery point exists; **restore drill succeeded once against a production backup** (see Backup & DR section)
- [ ] Account creation restricted (enterprise default)
- [ ] Customer's operator can run `kortix self-host status`/`logs`/`update`/`rollback` without help

## v1 limitations (document, set expectations)

- **Sandboxes** = Daytona (or Platinum/E2B) via egress — cloud sandbox VMs outside the customer's network. Single-tenant on-box sandboxes (`local-docker`) are experimental, not for production.
- **Availability** = one host. RTO = snapshot restore (documented drill). RPO ≈ 1h (hourly snapshots) or whatever cadence the customer configures.
- **Rollback** = `kortix self-host update --release <previous-version>` (or re-run `Promote Self-Host Stable` with an older version). The auto-updater's `flock` + per-service start-first swap means a failed swap never aborts the rest of the rollout — a degraded outcome self-heals on the next run.

## After onboarding

- **Continuous support.** The customer's operator owns day-2 operations via the runbook. Kortix FDE stays available for escalations.
- **Updates.** The `stable` channel is curated — not every prod release ships to self-hosted boxes overnight. A human runs the `Promote Self-Host Stable` workflow to repoint `:stable` → a proven version. Self-hosts pick it up on their next nightly auto-updater cycle.
- **Learning / education.** Bring Kortix into the customer's teams as a practice — the agent/skill/connector/session/memory model, the change-request workflow, the IAM surface. The goal is the customer's team running Kortix autonomously, not depending on FDE for routine work.
