# IAM admin guide

A practical reference for account admins working with the Kortix IAM
system. For the underlying design see
[`docs/specs/unified-iam-vault-access.md`](./specs/unified-iam-vault-access.md).

## Mental model

Kortix IAM follows the Cloudflare / AWS pattern:

1. **Roles** bundle related actions (e.g. `project_editor` grants
   `project.read`, `project.write`, `project.session.start`, …).
2. **Policies** attach a role to a **principal** (member / group /
   token / service account) at a **scope** (whole account, single
   project, project group, etc.).
3. The **engine** decides every request: union of all allow-policies
   the principal qualifies for, minus any explicit deny.

System roles ship out of the box (Administrator, Project Editor, …).
Custom roles are account-owned and built from the action catalog.

## Principals

| Kind | Example | Notes |
|---|---|---|
| `member` | `alice@acme.com` | Regular human account member. |
| `group` | "Mobile editors" | Inherited by every member of the group. |
| `token` | PAT or service account | Token-as-principal: when a token has any policy, only its own policies decide (no minter inheritance). |

External users (consultants) attach via **Settings → External access**.
They behave like members but don't consume a regular seat and can carry
an auto-revoke timestamp.

## Scopes

| Scope | Matches |
|---|---|
| `account` (Everything) | All resources in the account. |
| `project` | One project, or every project when `scope_id=null`. |
| `project_group` | Every project currently in the group. |
| `member` / `group` | Manage that specific principal. |
| `sandbox` / `trigger` / `channel` | One sub-resource by id (paste the id). |

## Settings tab — what each card does

| Card | Purpose |
|---|---|
| **Strict IAM mode** | Disables the legacy account_role + project_members bridges. Only super-admin + explicit policies decide. Use **Backfill memberships** first to mirror current state into policies. |
| **MFA enforcement** | Forces aal2 for every browser/JWT request. Super-admins and PATs are exempt. |
| **SAML SSO** | Attach a Supabase auth.sso_provider; map IdP group claims to IAM groups so JIT users land in the right groups. |
| **Session controls** | Per-account session max-lifetime, idle timeout, and force-logout list. PATs exempt. |
| **CLI token lifecycle** | Cap PAT lifetime, require expiry on every mint, auto-revoke idle PATs. Sandbox-injected PATs exempt. |
| **Two-person rule** | Require approval from a second super-admin for sensitive actions (super-admin grant, MFA disable, account delete). |
| **Project groups** | Bundle projects so one policy can target many. |
| **Service accounts** | Non-human identities with their own bearer + policies. |
| **Break-glass** | Self-activate temporary super-admin with mandatory reason + auto-expiry. |
| **External access** | Cross-account sharing for consultants/partners. |
| **SCIM tokens** | Bearer tokens for IdP-driven user provisioning. |
| **Audit webhooks** | Stream audit events to Splunk/Datadog. Use the "IAM only" preset to scope to `iam.*` events. |

## Common workflows

### Onboarding an engineering team

1. Create a **Group** ("Engineering").
2. Create a **Project group** ("Production") containing the prod
   projects.
3. Create a **Policy** on the engineering group with the
   `project_editor` role scoped to the production project group.
4. SCIM/SAML-provisioned engineers land in the IAM group via claim
   mapping; the policy follows automatically.

### Locking down a CI bot

1. Create a **Service account** in Settings → Service accounts.
2. From the bot's member detail view, attach a `project_editor`
   policy scoped to the one project the CI deploys to.
3. Optionally enable Settings → CLI token lifecycle to enforce
   90-day rotation.
4. Apply the **CI/CD bot — single project** policy template for a
   one-click baseline.

### Tightening access

1. Use the **Audit tab → Permission usage analytics** to see who
   actually uses which actions.
2. Use **Audit tab → IAM drift** to find unused policies and empty
   groups.
3. Attach a **Permission boundary** (member detail) to cap the max
   envelope for high-risk members.
4. Enable **Strict IAM mode** in Settings to lock the engine to
   explicit policies only.

### Incident response

1. Activate **Break-glass** with a reason — temporary super-admin
   auto-expires in 1 hour by default.
2. Resolve the incident.
3. Audit log captures activation + revocation + every action taken
   under the grant.

## Engine evaluation order

1. **PAT path**: if the request has a PAT and that PAT has any
   policies → evaluate ONLY the PAT's policies (no minter
   inheritance, no super-admin bypass).
2. **Not-a-member** → deny.
3. **Super-admin bypass** → allow (break-glass counts as super-admin).
4. **Account MFA gate** (if enabled) → deny when aal != aal2.
5. **Permission boundary** (if set) → deny when action prefix not
   covered.
6. **Explicit policies** (direct + via groups, + project group
   expansion): deny wins over allow per (action, scope).
7. **Legacy bridges** (only when strict mode is off): owner/admin →
   Administrator role, member → account reads, project_members →
   matching project role.

## Conditions

A policy can carry `conditions` that gate when it applies:

- `ip_cidrs`: caller IP must match one entry (IPv4 + IPv6, bare IPs
  treated as /32 or /128).
- `require_mfa`: session must be Supabase aal2.

Conditions compose with AND. Unknown keys are ignored (forward-compat).
A policy whose conditions don't match is silent — it acts as if it
didn't exist, including denies.

## Expiry

Set an optional `expires_at` per policy. The engine filters expired
policies out of every query at the SQL layer; no cleanup job needed.
Use the preset chips (1d / 7d / 30d / 90d / custom) in the Create
Policy dialog.

## REST surface (highlights)

### Auth audit events

The audit log captures the full authentication lifecycle:

| Action | When it fires |
|---|---|
| `auth.login.success` | A token (JWT / PAT / SA / Kortix key) verifies and the request proceeds. Metadata carries auth method + AAL. |
| `auth.login.fail` | About to return 401. Metadata carries the rejection reason (`bad_signature`, `expired`, `pat_revoked`, etc.). Captured even for unknown principals — useful as an intrusion signal. |
| `auth.logout` | Explicit `POST /v1/auth/logout`. Frontend `signOut` calls this before tearing down the Supabase session. |
| `auth.session.first_sight` | First time a session_id is observed against a given account. Backed by the session-gate's UPSERT into `account_session_activity`. |

Stream them to your SIEM via Audit webhooks with action_prefix `auth.`.

### REST surface (highlights)

| Endpoint | Purpose |
|---|---|
| `GET /v1/accounts/:id/iam/roles` | List roles available to this account. |
| `POST /v1/accounts/:id/iam/policies` | Create a policy. |
| `POST /v1/accounts/:id/iam/policies:bulk-import` | Bulk import from JSON. |
| `POST /v1/accounts/:id/iam/policies:simulate` | Read-only impact preview. |
| `POST /v1/accounts/:id/iam/policy-templates/:key/apply` | Apply a curated template. |
| `GET /v1/accounts/:id/iam/drift` | Drift report (unused policies, empty groups, …). |
| `GET /v1/accounts/:id/iam/analytics/usage` | Action usage counters. |
| `POST /v1/accounts/:id/iam/break-glass/activate` | Time-bounded super-admin. |
| `POST /v1/accounts/:id/iam/external-grants` | Attach an external user by email. |
| `/scim/v2/accounts/:id/Users` | SCIM 2.0 (IdP-driven). |

## Troubleshooting

**A user can't see a project they should have access to.**
1. Open the member detail page → check the **Effective capabilities**
   panel.
2. Check **Permission boundary** — has it been set?
3. If strict mode is on, confirm the legacy `project_members` row
   was migrated. Settings → Strict IAM → **Backfill memberships**.

**A PAT is unexpectedly denied.**
- If the PAT has any policies attached, ONLY those policies decide
  (no inheritance from the minter). Check the token detail page.
- Account-wide MFA enforcement is bypassed for PATs, but per-policy
  `require_mfa` conditions are not — check the policy conditions.

**MFA enforcement bricked the account.**
- Super-admins always bypass. Have a super-admin sign in and toggle
  it off in Settings. The endpoint refuses the initial flip if it
  would orphan the account (no super-admin AND no enrolled members).

**Strict mode locked someone out.**
- Run the **Backfill memberships** action (Settings → Strict IAM
  card) to mirror remaining legacy rows.
- Or temporarily disable strict mode (no preview/lockout risk on
  disable).

## Cheat sheet — common roles

| Role key | What it grants |
|---|---|
| `administrator` | Everything in the account. |
| `administrator_read_only` | All reads, no writes. |
| `member` | Account-level reads (baseline for regular users). |
| `project_admin` | Full control on one project. |
| `project_editor` | Read + write + run sandboxes on one project. |
| `project_viewer` | Read-only on one project. |
