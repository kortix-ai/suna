# Kortix IAM — The Complete Administrator's Guide

**Identity, SSO (SAML), SCIM provisioning, roles, groups, custom roles, agent access, and audit.**

This is the operator's manual for everything access-related in Kortix: how authorization
actually decides, what the built-in roles grant, how to wire up your identity provider
(Okta, Microsoft Entra ID, or any SAML IdP), how directory sync works, how to build
custom roles that do exactly what you want, how agents and automation are contained,
and how to prove all of it to an auditor.

Companion documents:
- `docs/ENTRA_SSO_SCIM_SETUP.md` — the Microsoft Entra ID (Azure AD) end-to-end runbook.
- `docs/ENTERPRISE_EDITION.md` — what is entitlement-gated and how the gating works.

Everything below reflects the shipped code (paths cited inline where useful).

---

## 1. The mental model

Kortix authorization answers one question: **may this principal perform this action on
this target?** Five concepts cover the whole system:

| Concept | What it is | Examples |
| --- | --- | --- |
| **Principal** | Who is asking | A human member, a service account, an agent session, a personal access token |
| **Scope** | Where the action lives | The **account** (org-wide) or a **project** |
| **Action** | A precise capability string | `project.secret.read`, `member.invite`, `project.trigger.fire` |
| **Role** | A named set of actions | Built-in (`owner`, `admin`, `member`; `manager`, `editor`, `member`) or **custom** |
| **Policy** | A binding: principal → role @ scope | "Group *Support* holds role *read-run* on project X, until July 31" |

### The three rules that explain every outcome

1. **Allow-only, highest-wins union.** There is no "deny" rule and there are no
   conditions. Every grant a principal holds — direct project role, group grants,
   implicit role from their account role, custom-role policies — is **unioned**, and if
   *any* path allows the action, it is allowed. Consequence: a custom role can only ever
   *add* capabilities on top of a built-in grant, never subtract from one (see the
   [union trap](#the-union-trap), the single most important thing to understand).

2. **Owners and admins hold implicit Manager on every project.** An account `owner` or
   `admin` doesn't need project membership — they always act as project Manager. Plain
   account `member`s only reach projects they've been explicitly granted (directly, via
   a group, or via a custom-role policy).

3. **Every route enforces its exact capability.** Each API endpoint asserts the specific
   leaf action it represents (e.g. reading a secret value asserts
   `project.secret.read`). The dashboard mirrors this: a customize section is *visible*
   if you hold its **read** leaf and *editable* if you also hold its **write** leaf —
   read-without-write renders a clean read-only view. UI visibility is a convenience
   layer; the API re-checks every request.

### How a request is decided (in order)

1. **Token scope** — a project-bound token cannot leave its project or perform account
   actions at all.
2. **Super-admin** bypasses everything (including the MFA gate). Reserved for platform
   operations; granted only by an owner (`member.super_admin.grant`).
3. **Account MFA gate** — if the account has `mfa_required` on, browser sessions must be
   at AAL2 (MFA verified). PATs and service accounts are exempt (they are credentials,
   not login sessions).
4. **Account scope** — built-in account role first, then custom policies (union).
5. **Project scope** — effective built-in role = max(implicit Manager if owner/admin,
   direct membership, every group grant), then custom policies (union). Expired grants
   are invisible the instant the clock passes.
6. **Per-resource grants** — if the target is a *scoped* agent/skill, the caller must be
   one of its assignees (owners/admins bypass).
7. **Agent-grant fold** — if the caller is an agent session, the verdict is intersected
   with the agent's `kortix_cli` grant (section 8).

### Caching and revocation

- Verdicts are cached for **15 seconds** per principal, and only *positive* results are
  cached — a fresh grant is visible immediately.
- Every IAM mutation (role change, group membership, policy write, offboarding, SCIM
  deactivation) **busts the affected users' cache synchronously**, so revocation on the
  replica that handled the write is immediate; worst case across replicas is one 15 s
  TTL window.
- Time-boxed grants are enforced in SQL (`expires_at > now()`), so expiry is exact to
  the second — no sweeper or cache flush needed.

### What deliberately does *not* exist (v1)

- No `deny` rules, no policy conditions, no IP allow-lists (an account-wide MFA
  requirement is the one environmental gate).
- No per-policy MFA/IP predicates; `deny` and per-resource `deny` effects are reserved
  enum values, rejected at the API.
- One SAML IdP per account.

---

## 2. Built-in roles

Built-in roles are fixed in code — predictable, non-editable, and always available.
Custom roles (section 5) exist for everything the built-ins don't express.

### Account roles

| Capability | `member` | `admin` | `owner` |
| --- | :---: | :---: | :---: |
| Read account, billing, members, groups, tokens | ✅ | ✅ | ✅ |
| Edit account settings (`account.write`) | — | ✅ | ✅ |
| Invite / update / remove members | — | ✅ | ✅ |
| Create / edit / delete groups, manage group members | — | ✅ | ✅ |
| Create / revoke tokens | — | ✅ | ✅ |
| Read the audit log (`audit.read`) | — | ✅ | ✅ |
| Manage custom roles & policies | — | ✅ | ✅ |
| Create projects | — | ✅ | ✅ |
| Delete the account, billing writes, grant super-admin | — | — | ✅ |

> Owners and admins additionally act as **Manager on every project** (implicit).

### Project roles

`member ⊂ editor ⊂ manager` — each is a strict superset.

| Capability | `member` (floor) | `editor` | `manager` |
| --- | :---: | :---: | :---: |
| Read the project; use chat; **start/stop sessions**; **fire triggers** | ✅ | ✅ | ✅ |
| Read agents, skills, commands, customization, git history, connectors | ✅ | ✅ | ✅ |
| See members; read gateway logs & spend; Review inbox (read + submit) | ✅ | ✅ | ✅ |
| **Browse repo files** (`project.file.read`) | — | ✅ | ✅ |
| **View secret values** (`project.secret.read`) | — | ✅ | ✅ |
| Edit anything (agents, skills, commands, files, customization, connectors, secrets) | — | ✅ | ✅ |
| Create/update/delete triggers; deploy; push/merge via gitops; act on reviews | — | ✅ | ✅ |
| Set gateway budgets | — | ✅ | ✅ |
| Manage project members; delete the project; manage gateway keys | — | — | ✅ |

Two deliberate design points:

- **`member` is the floor *usable* role**: it can genuinely *use* Kortix (chat, run and
  stop sessions, operate automations via `trigger.fire`) but cannot browse the file
  tree, view secret values, or customize anything. "Give them the agent, not the
  internals" is expressible with zero custom-role work.
- The retired `viewer` / `user` tiers fold into `member` automatically — they are no
  longer assignable.

---

## 3. Projects & membership

**UI:** project → **Customize → Members** (deep link `/projects/{id}/customize/members`),
tabs **People** and **Invite**.

### Adding people

- **Invite** (needs `project.members.manage`, i.e. project Manager or account
  owner/admin): enter emails, pick `manager` / `editor` / `member`, optionally set an
  expiry. Existing users are added instantly; unknown emails receive an **account
  invitation carrying a bootstrap project grant** — accepting it joins the org *and* the
  project in one step. Pending invites can be resent or revoked from the same tab.
- **Access requests**: a user who can see a project link can *request access*; requests
  land in the Invite tab for a Manager to approve (with a role) or reject.

### Managing people

- Change a member's role or expiry from the **People** tab
  (`PUT /v1/projects/{id}/access/{userId}` with `role`, optional `expires_at`).
- The member list shows each person's **effective** role and *why* they have it:
  a direct grant, "account admin" (implicit Manager), or "via *Engineering*" (a group
  grant). Everyone in the project can see who's in it; sensitive columns are limited to
  self + managers.

### Time-boxed access

Set `expires_at` on any direct membership, group grant, or policy. Enforcement is exact
(SQL-level); when a grant expires, a background sweeper writes an audit event
(`iam.project.member.expired` / `iam.project.group.expired`) and leaves the row visible
as **Expired** so you can see what lapsed.

**Example — contractor with a 30-day editor window:**
Invite `jo@vendor.com` as `editor`, expiry 30 days out. On day 30 the access dies at the
exact timestamp, the audit trail records it, and their row shows "Expired" until you
remove or renew it.

---

## 4. Groups

Groups are your departments: **Engineering**, **Support**, **Marketing**. They come from
three sources — created by hand (`manual`), pushed by your directory (`scim`), or
auto-provisioned from SAML claims (`sso`) — and all three behave identically once they
exist.

**UI:** `/accounts/{accountId}?tab=groups` → group detail page with **Group members /
Projects / Settings** tabs.

### What a group does

1. **Holds members** (added by hand or synced from the IdP — sections 6–7).
2. **Grants project roles**: attach the group to a project at `manager` / `editor` /
   `member` (optional expiry). Every group member inherits that role on that project.
   *The default role for new grants is `member`* — start people at the floor and raise
   deliberately.
3. **Can hold custom-role policies** (section 5) for capability sets the built-ins
   don't express.

### Things the UI will warn you about

- **Owner/admin override**: account owners/admins in a group always keep implicit
  Manager, regardless of the group's grant role. The group page shows a heads-up with a
  count ("N of M get Manager anyway").
- **The union trap chip**: if a group holds *both* a built-in project grant *and* a
  custom-role policy on the same project, the built-in grant wins (allow-only union) and
  the row is flagged **"⚠ overrides an assigned custom role"** — detach the built-in
  grant to let the custom role govern. Full explanation in section 5.

### Attach a group to a project

From the group page (**Projects → Attach to project**: only projects you Manage are
offered) or from the project side (**Customize → Members → Group access**). Both call
`POST /v1/projects/{projectId}/group-grants` `{group_id, role, expires_at?}` — an
idempotent upsert, so re-attaching updates the role.

---

## 5. Custom roles & policies

Custom roles are for everything the three built-in project roles can't say: *"read and
run, but also manage secrets"*, *"everything except connectors"*, *"audit-only"*.

**UI:** `/accounts/{accountId}?tab=roles` — a roles table plus an **Assignments** card.
**CLI:** `kortix roles …` (full parity, including IAM-as-code export/import).

### Creating a role

1. **New role** (or **Duplicate** a built-in preset to prefill its capability set —
   the fastest path to "editor minus X").
2. Pick a key (`[a-z0-9_]{2,64}`), a display name, and the **scope type**:
   `project` (bindable to individual projects) or `account` (bindable account-wide).
3. Tick capabilities in the matrix. Two guardrails apply:
   - **Namespace integrity** — account roles hold only account actions, project roles
     only project actions.
   - **The non-delegable ceiling** — org-administration powers can never be placed in a
     custom role: `account.delete`, `billing.write`, member invite/update/remove, group
     create/update/delete/members.manage, role & policy management, token
     create/revoke. Custom roles delegate *work*, not *governance*.
4. Editing a role's permission set applies **immediately** to every holder (their cache
   is busted on save).

### Binding a role (policies)

A role does nothing until a **policy** binds it to a principal at a scope:

- **Where:** account Roles tab → *Assignments* (any scope), or per-project on
  **Customize → Members → Custom roles** (that project only).
- **Principal:** a member, a **group**, or an **agent identity** (section 8).
- **Scope:** one project, or account-wide (= every project). A policy's scope type must
  match the role's scope type. Agent (token) principals must be project-scoped —
  an agent can never be granted account-wide powers.
- **Expiry:** optional `expires_at`, enforced to the second.
- Built-in roles are **not** bindable via policies — assign those through project
  members/group grants. (Policies are the custom-role mechanism.)

API: `POST /v1/accounts/{accountId}/iam/policies`
`{principalType: member|group|token, principalId, roleId, scopeType: account|project, scopeId?, expires_at?}`.

### <a name="the-union-trap"></a>The union trap (read this twice)

The engine is **allow-only**: every grant path is unioned, so a custom role can only
*add*. If a principal *also* holds a built-in grant, the built-in grant's capabilities
remain — a "restrictive" custom role does nothing while a broader built-in grant exists.

**Wrong:** group *Support* is attached to project X as **Editor**, and you bind a
read-only custom role hoping to restrict them. Result: they're still Editors.

**Right:** detach the built-in group grant (or direct membership) and let the custom
role be the **sole** grant path. A custom-role policy standing alone is fully
authoritative — the person gets *exactly* the ticked capabilities, nothing else.

The project Members UI detects the wrong state and marks the group row with
**"⚠ overrides an assigned custom role."** When you see that chip, detach the built-in
grant.

### Worked examples

**A. "Support" — use the agent, touch nothing** *(no custom role needed)*
Add the group to the project at role **member**. They can chat, run/stop sessions and
fire triggers, but can't browse files, read secret values, or edit anything.

**B. "Secrets manager" — floor access plus secrets**
```
key: secrets_manager   scope: project
actions: project.read, project.session.start, project.session.stop,
         project.secret.read, project.secret.write
```
Bind to the person/group on the project **with no built-in grant**. They see the
customize rail with just the sections they can read; Environment variables is fully
editable; everything else is invisible or read-only.

**C. "Read-only auditor" — see everything, change nothing**
```
key: auditor   scope: project
actions: project.read, project.file.read, project.secret.read,
         project.gitops.read, project.agent.read, project.skill.read,
         project.command.read, project.customize.read, project.connector.read,
         project.trigger.read, project.session.read, project.members.read,
         project.review.read, project.gateway.logs.read, project.gateway.spend.read
```
Every customize section renders read-only; every mutation 403s server-side.

**D. "Member manager" — delegate membership without edit rights**
```
key: member_manager   scope: project
actions: project.read, project.members.read, project.members.manage
```
Can invite/remove/re-role people on the bound project but cannot edit the project
itself.

**CLI equivalents:**
```bash
kortix roles create secrets_manager --name "Secrets Manager" --scope project \
  --actions project.read,project.session.start,project.session.stop,project.secret.read,project.secret.write
kortix roles assign secrets_manager --to member:<user-id> --project <project-id>
kortix roles assignments --project <project-id>
kortix roles export > iam-roles.toml     # IAM-as-code snapshot
kortix roles import iam-roles.toml       # re-create roles + bindings elsewhere
```

### Verifying what someone can do

- Member detail page (`/accounts/{id}/members/{userId}`): their groups and every project
  they can reach, with the source of each grant.
- API probes: `GET /v1/accounts/{id}/iam/members/{userId}/effective?action=<action>`
  (and `/effective:batch`) answer "would this user be allowed to…?" against the live
  engine. There is no separate simulator — this *is* the engine's answer.

---

## 6. SAML single sign-on

### How it fits together

```
                 ┌── SAML (auth) ─────────►  who is signing in (+ live group claim)
 Your IdP ───────┤
                 └── SCIM (provisioning) ─►  who exists / who is in which group (pushed)

 IdP group ──(mapping: claim value → group)──► Kortix IAM group
 IAM group ──(project grant: group → role)───► role on a project
 role ───────(authorization engine)──────────► what the user may do
```

SAML answers *who is signing in* and carries their groups in a claim on every login
(just-in-time sync). SCIM (section 7) *pushes* changes proactively, so offboarding and
group moves don't wait for a login. Both meet in **IAM groups**, and groups confer
access only through the grants **you** create — a synced group grants nothing by itself.

**Prerequisites:** the `sso` entitlement (Enterprise tier, or the self-serve
*Enterprise demo* toggle — section 10), account owner/admin on the Kortix side, admin on
the IdP side. Kortix delegates SAML validation to its Supabase Auth layer, but you never
need to touch that layer directly — the SP **Entity ID** and **ACS URL** your IdP asks
for are shown, with copy buttons, on the SAML SSO card's **Service provider details**
before you configure anything. *(Self-hosted operators can alternatively read them
straight from the Supabase project's SAML configuration — see the Entra runbook — but
the card is the source every customer should use.)* Both values are safe to hand to your
IdP admin: the Entity ID / metadata URL is a public-by-design SAML endpoint that IdPs
must be able to fetch, and it exposes no account data; a custom auth domain can brand it
later.

### Connect your IdP (self-serve)

1. **In the IdP**, create a SAML app (Okta: *SAML 2.0 app*; Entra: *Enterprise
   Application → Single sign-on → SAML*) using the SP Entity ID + ACS URL copied from
   the SAML SSO card's **Service provider details**. Download the **IdP metadata XML**
   (or copy its URL).
2. **In Kortix:** `/accounts/{accountId}?tab=settings` → **Identity & directory** →
   **SAML SSO** → **Configure** (the card appears once the `sso` entitlement is live).
3. In the default **Import IdP metadata** mode, paste the metadata XML or URL and set:

   | Field | Meaning | Notes |
   | --- | --- | --- |
   | Display name | Label in the UI | required |
   | **Primary email domain** | Routes sign-ins for `you@thatdomain.com` to this IdP | e.g. `acme-inc.com`; extra domains can be added at import |
   | **Group claim name** | The SAML attribute carrying group memberships | default `groups` (Okta convention); Entra emits `memberOf` |
   | **Auto-create members** | Any successful SSO login from the domain self-provisions a baseline account `member` | default **on**; turn **off** for strict, invite/SCIM-only membership |
   | **Auto-provision groups** | Unmapped group claims automatically create an IAM group (+ mapping) on login | default **off** — see below |

4. **Import & configure.** Kortix registers the IdP with its auth layer server-side and
   stores the provider. Errors are explicit: *409* = a provider already exists (one IdP
   per account — remove it first) or the domain is claimed elsewhere; *501* = SAML isn't
   enabled on the auth project (operator action).
5. *Advanced path:* an operator who has already registered the IdP with Supabase can
   paste the provider UUID in **Advanced: Supabase UUID** mode instead.

### Emit the group claim

Configure the IdP to include the user's groups in assertions, under the exact claim
name you configured:

- **Okta:** add a *group attribute statement* named `groups` (filter to the relevant
  groups to keep assertions small).
- **Entra:** *Attributes & Claims → Add a group claim* — emits `memberOf`, with group
  **Object IDs (GUIDs)** by default (or switch to names). Details in the Entra runbook.

Whatever the IdP emits — GUID or display name — is the **claim value** you map next.
Matching is case- and whitespace-insensitive.

### Map groups to access

Two modes:

**Manual mapping (default — recommended for tight control).**
On the SAML SSO card → **Add mapping**: claim value → IAM group (one claim value maps to
exactly one group). Then grant that IAM group project roles (section 4). Unmapped
claims are ignored — fail-safe, no surprise access.

**Auto-provision groups (`auto_provision_groups` on).**
Every *unmapped* claim value in a login automatically creates an IAM group (source
`sso`) plus its mapping, and the user joins it. The groups still confer **zero** project
access until you grant them roles — auto-provisioning saves the clerical step of
mirroring your org chart, not the access decision.

### What happens on login (JIT sync)

Users sign in at **`/auth`** by typing their work email — if the domain matches a
configured IdP, the browser is redirected to it (SP-initiated; works from both the
sign-in and register tabs, so first-time SSO users are provisioned on the spot).
IdP-initiated login is not supported.

On the first authenticated request after login, Kortix:

1. Resolves the SSO provider → owning account.
2. Ensures account membership (role `member`) — only if `auto_create_members` is on;
   otherwise only pre-invited/SCIM-provisioned users proceed.
3. Reads the group claim, auto-provisions groups if enabled, then **reconciles**
   mapped group memberships: joins claimed groups, leaves mapped groups no longer
   claimed. *Manually-added memberships are never touched* — sync only manages what it
   manages.
4. Busts the user's authorization cache, so group-granted roles apply on that same
   session.

### Lifecycle & troubleshooting

| Situation | Behavior |
| --- | --- |
| User removed from an IdP group | Loses the group (and its project roles) on next login/SCIM push; ≤ 15 s cache lag |
| Mapping deleted | Auto-join stops; existing membership rows persist until next reconcile removes them |
| Provider deleted | New SSO sign-ins stop; **existing members keep access** (removal never locks you out; deletion is deliberately never entitlement-gated) |
| Entitlement lapses | Config mutations 402; reads, mapping deletion, and provider disconnect keep working |
| Groups not syncing | Check the **group claim name** matches what the IdP emits, and that mappings exist; a mismatch fails safe (no groups, no error) |
| Wrong user routed to password login | The email's domain isn't the provider's primary/extra domain |

Every SSO configuration change is audited (`iam.sso.provider.*`, `iam.sso.mapping.*`).

---

## 7. SCIM provisioning

SCIM 2.0 lets your directory push users and groups to Kortix proactively — offboarding
and group moves apply without waiting for a login. Enterprise-only; the entitlement is
re-checked on **every** SCIM request, so a token minted while entitled stops working on
downgrade.

### Set up

1. **Mint a token:** `/accounts/{accountId}?tab=settings` → **Identity & directory** →
   **SCIM Provisioning** → *New SCIM token* → name it (e.g. "Okta production").
   The `kortix_scim_…` secret is shown **once** — copy it now. The card also shows your
   **SCIM base URL**:
   ```
   https://<your-api-origin>/scim/v2/accounts/{accountId}
   ```
   Tokens are stored hashed, can carry an expiry, track `last_used_at`, and are
   revocable at any time (revoke never requires the entitlement — you can always kill a
   leaked credential). Rotation = mint new → reconfigure IdP → revoke old.

2. **Okta** — app → *Provisioning* → Integration:

   | Setting | Value |
   | --- | --- |
   | SCIM connector base URL | the base URL above |
   | Unique identifier field for users | `userName` *(Kortix treats it as the email)* |
   | Supported provisioning actions | Push New Users, Push Profile Updates, Push Groups |
   | Authentication Mode | **HTTP Header** — bearer = the `kortix_scim_…` secret |

   *Test Connector Configuration* runs a filtered `/Users` query and should pass
   immediately. Then enable *Provisioning to App* (Create/Update/Deactivate) and assign
   users/groups.

3. **Microsoft Entra ID** — Enterprise app → *Provisioning* → Automatic:
   **Tenant URL** = the base URL, **Secret Token** = the SCIM token. *Test Connection*
   works because Kortix serves the discovery endpoints Entra probes
   (`/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`).

### Semantics you should know

| Event | What Kortix does |
| --- | --- |
| **Push user (existing Kortix user)** | Idempotent membership upsert, account role `member`; `externalId` recorded |
| **Push user (unknown email)** | Creates a 14-day **invitation** (no email sent); reported back as an `active:true` user; converts to a real member on their first SSO sign-in |
| **Profile update** | Okta uses PUT, Azure uses PATCH — both supported; unknown attributes are accepted as no-ops so pushes never error |
| **Deactivate / unassign / DELETE** | **Removes account membership, revokes all their PATs and live session tokens**, busts caches, audits. Response mirrors the resource so IdPs don't loop |
| **Last-owner guard** | The sole account owner cannot be deactivated via SCIM (409) — an IdP misconfiguration can't lock the account |
| **Push group** | Creates a real IAM group (source `scim`) — the same groups you attach to projects and bind policies to |
| **Group membership changes** | Okta add/remove and Azure's wholesale `members` replace both supported; caches busted for affected users |

SCIM assigns no roles: pushed users always join as account `member`, and pushed groups
start with **no** project grants — access is still your explicit group→role step
(section 4). Boundaries: filters support `attr eq "value"` only, one result page (no
pagination), no bulk operations, no PUT on Groups.

Every SCIM mutation is audited (`scim.user.*`, `scim.group.*`) with the SCIM token as
the actor.

---

## 8. Agents, automation & tokens

Humans are half the picture. Kortix agents act with **contained**, auditable authority.

### The containment model

An agent session's effective power is an **intersection** — never wider than any factor:

```
effective = (launching user's role  |  agent's standing role)
          ∩ the agent's kortix_cli grant
          ∩ the session token's project scope
```

- The **`kortix_cli` grant** is declared per agent in the project manifest
  (`kortix.yaml`):

  ```yaml
  agents:
    kortix:
      connectors: all          # which integrations it may call
      secrets: all             # which project secrets it may read ($ENV)
      kortix_cli: all          # which Kortix platform actions it may perform
    release-bot:
      kortix_cli: [project.cr.open, project.trigger.create]   # exactly two powers
      connectors: [github]
      secrets: [DEPLOY_KEY]
  ```

  v2 manifests are **deny-by-default**: an agent declared without a grant field gets
  *none* of that dimension. An agent absent from an adopted `agents:` map gets nothing
  at all. Grants are read from the **default branch** — an agent can propose widening
  its own powers in a change request, but the change only takes effect once a human
  merges it.
- Grantable `kortix_cli` actions are the project action catalog (§12); `'all'` and
  `'*'` mean unrestricted. `project.cr.open`/`project.cr.merge` and
  `project.gitops.push`/`project.gitops.merge` are alias pairs — either spelling works.
- **Secrets and connectors** can be scoped from the dashboard without touching YAML:
  **Customize → Agents → Access scope** (needs `project.agent.write`; saves as a
  manifest commit). `kortix_cli` is deliberately **not** editable in the UI — platform
  powers are a sharper escalation and stay a reviewed manifest change.

### Standing agent identities (agents as teammates)

Every declared agent gets an auto-provisioned **agent identity** (a service account that
cannot be used as a bearer credential). By default it stays dormant and agent sessions
act as *launching user ∩ grant*. To give an agent **standing** authority independent of
who launched it: `/accounts/{id}?tab=roles` → bind a custom role to the agent identity
(principal type *Agent*, project-scoped — account-wide agent policies are rejected).
From then on its sessions authorize as *standing role ∩ grant*. Bind an empty role to
hard-lock an agent regardless of who runs it.

### Assigning agents to people (resource grants + inheritance)

**Customize → Members → Resource access** assigns an agent to a member or group
(`project.members.manage` required). Two effects:

1. **Scoping** — once an agent has ≥ 1 assignment it becomes *scoped*: only assignees
   (and owners/admins) can use it. Unassigned agents remain open to the whole project.
2. **Inheritance** — assignees inherit the agent's *declared* secrets and connectors as
   their own (with provenance shown in the UI: "you inherit STRIPE_KEY from
   billing-bot"). Assigning a human to an agent is a real access decision — treat it
   like one.

### Service accounts & tokens

| Credential | Prefix | Purpose | Powers |
| --- | --- | --- | --- |
| Browser session | (JWT) | Humans in the dashboard | The user's roles; subject to the account MFA gate |
| Personal access token | `kortix_pat_` | CLI / scripts as *you* | Your roles; optionally **project-scoped** (hard-fenced to that project); exempt from the MFA gate |
| Service account | `kortix_sa_` | Headless automation with its **own** identity | *Only* its bound policies — no roles means every call is denied (fail-closed) |
| SCIM token | `kortix_scim_` | Your IdP's provisioning credential | The SCIM API only, one account |
| Session executor token | (internal) | Minted per sandbox for the agent | launching-user/standing role ∩ agent grant ∩ project |

- **PATs:** user menu → Settings → **API keys** (name, optional project scope, optional
  expiry; secret shown once). Admins set an account-wide **PAT policy** —
  require-expiry, maximum lifetime, idle auto-revoke — under
  `/accounts/{id}?tab=settings → Tokens & automation`. Offboarding a member revokes
  every token they hold, including live session tokens.
- **Service accounts:** created next to the PAT policy card (secret shown once), granted
  exclusively via policies (`principalType: token`), disabled/deleted with immediate
  cache bust. No rotate — revoke and recreate.

---

## 9. Audit & compliance

Recording is always on, on every tier: every state-changing API request is logged, plus
named events for every security-relevant action — logins (`auth.login.success|fail`),
IAM changes (`iam.role.*`, `iam.policy.*`, `iam.group.*`, `iam.sso.*`,
`iam.scim.token.*`, `iam.service_account.*`), SCIM operations (`scim.user.*`,
`scim.group.*`), grant expiries, session revocations. Events carry actor, action,
resource, before/after, IP, user agent, and metadata.

**Reading it** (needs `audit.read` + the `auditAccess` entitlement):

- **UI:** `/accounts/{id}?tab=audit` — quick filters (IAM only, group changes, project
  access, super-admin grants, 24 h/7 d/30 d) and one-click **CSV / JSONL export**
  (10,000 rows per pull; page with `since`).
- **API:** `GET /v1/accounts/{id}/audit?action=iam.&since=…&cursor=…` and
  `GET /v1/accounts/{id}/audit/export?format=csv|jsonl`.

**Streaming to a SIEM:** `/accounts/{id}?tab=settings` → **Observability** → *Add
webhook* (name, HTTPS URL, optional action prefix such as `iam.`). You get a `whsec_…`
secret once, plus an immediate test delivery. Every delivery is signed —
verify `X-Kortix-Signature: sha256=HMAC-SHA256(secret, raw_body)`; idempotency and
webhook-id headers included. Failures stamp `last_error` on the webhook row. On
downgrade, delivery stops per-event, but you can always list and delete leftover hooks.

---

## 10. Enterprise entitlements

Four feature flags gate the enterprise surface; everything else is never paywalled.

| Entitlement | Gates | Tier |
| --- | --- | --- |
| `sso` | SAML provider config, group-claim mappings | Enterprise |
| `scim` | SCIM token mint + the `/scim/v2` API (checked per request) | Enterprise |
| `rbac` | Creating/growing custom roles, policies, groups | **All tiers** (un-gated 2026-07-08) |
| `auditAccess` | Reading/exporting/streaming the audit trail | Enterprise |

- Mechanism: every account resolves to a billing tier; only the sales-assigned
  `enterprise` tier carries all flags. Gated routes return
  `402 {code: "entitlement_required", entitlement: "..."}`.
- **Reduction is never gated**: revokes, deletes, provider disconnect, webhook cleanup
  and SCIM-token revocation all work on any tier — a downgraded account can always
  shrink its attack surface.
- **Enterprise demo:** account admins can self-serve preview the whole enterprise
  surface — `/accounts/{id}?tab=settings` → *Enterprise demo* toggle (clearly labeled;
  flips `demo_enterprise`, which unlocks everything the enterprise tier grants).

---

## 11. Recipes

**Onboard a department from your IdP, end-to-end**
1. Connect SAML (§6) and SCIM (§7).
2. In the IdP, assign the *Engineering* group to the app; SCIM pushes it → an IAM group
   (source `scim`) with its members appears.
3. Attach the group to the right projects at `member` or `editor` (§4).
4. Done: joiners inherit access on push/login; leavers lose it on push — with the PAT +
   session-token revocation sweep on deactivation.

**Give a customer success rep chat-only access**
Add them (or their group) to the project as **member**. Nothing else needed — floor
membership is chat + sessions + trigger fire, with no file/secret/customization access.

**Delegate secrets management without edit rights** — recipe B in §5.

**Time-boxed incident access**
Invite the responder as `editor` with `expires_at` = +48 h. Access self-destructs; the
audit log records both the grant and the expiry event.

**Lock an agent to two capabilities**
```yaml
agents:
  release-bot:
    kortix_cli: [project.cr.open, project.trigger.create]
    connectors: [github]
    secrets: [DEPLOY_KEY]
```
Sessions of `release-bot` can open change requests and deploy — and literally nothing
else, no matter who launches them (the grant intersects the launcher's role).

**Prove "who could touch production secrets" to an auditor**
1. `/accounts/{id}?tab=audit` → filter `iam.` → export JSONL (grants/revocations).
2. Project → Customize → Members: effective roles with sources (direct / group / admin).
3. `GET /iam/members/{userId}/effective?action=project.secret.read` for a live yes/no
   per user.

---

## 12. Reference

### Project action catalog

| Family | Actions |
| --- | --- |
| Core | `project.read` · `project.write` · `project.delete` |
| Change requests | `project.cr.open` · `project.cr.merge` *(aliases of `gitops.push`/`gitops.merge`)* |
| Sessions | `project.session.read` · `project.session.start` · `project.session.stop` |
| Members | `project.members.read` · `project.members.manage` |
| Triggers | `project.trigger.read` · `.create` · `.update` · `.delete` · `.fire` |
| LLM gateway | `project.gateway.logs.read` · `.spend.read` · `.budget.set` · `.keys.manage` |
| Agents | `project.agent.read` · `project.agent.write` |
| Skills | `project.skill.read` · `project.skill.write` |
| Commands | `project.command.read` · `project.command.write` |
| Files | `project.file.read` · `project.file.write` |
| Customization | `project.customize.read` · `project.customize.write` |
| Git ops | `project.gitops.read` · `project.gitops.push` · `project.gitops.merge` |
| Secrets | `project.secret.read` · `project.secret.write` |
| Connectors | `project.connector.read` · `project.connector.write` |
| Review Center | `project.review.read` · `project.review.submit` · `project.review.act` |

Account actions: `account.read/write/delete`, `billing.read/write`, `audit.read`,
`member.read/invite/update/remove`, `member.super_admin.grant`,
`group.read/create/update/delete`, `group.members.manage`,
`policy.read/create/delete`, `role.read/create/update/delete`,
`token.read/create/revoke`, `project.create`.
Per-trigger scope: `trigger.read/update/delete/fire`.

### Where things live

| Surface | Path |
| --- | --- |
| Members / Groups / Roles / Audit / Settings | `/accounts/{accountId}?tab=members·groups·roles·audit·settings` |
| SAML SSO + SCIM cards, Enterprise demo, PAT policy, Service accounts, Audit webhooks | account **Settings** tab |
| Group detail | `/accounts/{accountId}/groups/{groupId}` |
| Member detail | `/accounts/{accountId}/members/{userId}` |
| Project members / group grants / custom-role bindings / resource access | `/projects/{id}/customize/members` |
| Agent access scope | `/projects/{id}/customize/agents` |
| Repo files (gated `project.file.read`) | `/projects/{id}/files` |
| Sign-in (SSO domain routing) | `/auth` |

### API quick reference

```
# SSO
GET|PUT|DELETE /v1/accounts/{id}/iam/sso/provider
POST           /v1/accounts/{id}/iam/sso/provider/from-metadata
GET|POST       /v1/accounts/{id}/iam/sso/mappings          DELETE …/mappings/{mappingId}

# SCIM management (session-authed) + SCIM service (token-authed)
GET|POST /v1/accounts/{id}/iam/scim/tokens                  DELETE …/scim/tokens/{tokenId}
https://<api>/scim/v2/accounts/{id}/Users|Groups|ServiceProviderConfig|ResourceTypes|Schemas

# Groups
GET|POST /v1/accounts/{id}/iam/groups                       GET|PATCH|DELETE …/groups/{groupId}
GET|POST …/groups/{groupId}/members                         DELETE …/members/{userId}
GET      …/groups/{groupId}/project-grants

# Custom roles & policies
GET /v1/accounts/{id}/iam/actions
GET|POST /v1/accounts/{id}/iam/roles                        PATCH|DELETE …/roles/{roleId}
GET|PUT  …/roles/{roleId}/permissions                       GET …/roles/{roleId}/usage
GET|POST /v1/accounts/{id}/iam/policies                     PATCH|DELETE …/policies/{policyId}
POST     …/policies:bulk-import | :bulk-delete
GET      …/iam/members/{userId}/effective?action=…          (+ /effective:batch)

# Project access
GET  /v1/projects/{id}/access                               POST …/access/invite
PUT|DELETE …/access/{userId}                                GET|POST …/access-requests (+ approve/reject)
GET|POST /v1/projects/{id}/group-grants                     PATCH|DELETE …/group-grants/{groupId}
GET|POST /v1/projects/{id}/resource-grants                  DELETE …/resource-grants/{grantId}

# Tokens & audit
GET|POST /v1/accounts/tokens                                DELETE /v1/accounts/tokens/{tokenId}
GET|POST /v1/accounts/{id}/iam/service-accounts             POST …/{saId}/disable   DELETE …/{saId}
GET /v1/accounts/{id}/audit (+ /export)                     GET|POST …/audit/webhooks  PATCH|DELETE …/{webhookId}
```

### Troubleshooting

| Symptom | Likely cause → fix |
| --- | --- |
| Custom role "isn't working" | The principal also holds a built-in grant (union trap) → detach the built-in group grant / direct role; look for the ⚠ chip |
| SSO groups not syncing | `group_claim_name` doesn't match the emitted claim, or no mapping exists → fix the claim name / add mappings (fails safe, silently) |
| `402 entitlement_required` | Feature is enterprise-gated → enterprise tier or the demo toggle (§10) |
| SCIM works, then stops | Entitlement lapsed (checked per request) or token revoked/expired → check tier + token status |
| User keeps access ~seconds after revoke | The 15 s cache TTL across replicas — by design; writes bust the local replica immediately |
| Okta "Test Connector" fails | Wrong base URL (must be `https://<api-origin>/scim/v2/accounts/{accountId}`) or missing bearer token |
| Member can't see the Files page | Floor `member` lacks `project.file.read` — raise to editor or grant a custom role with the leaf |
| Agent gets 403 on a platform action | Its `kortix_cli` grant lacks the action (or its standing role does) → widen the manifest grant via CR |

---

*This guide reflects the platform as of 2026-07-08. The authorization engine is
allow-only union (v1): no deny rules, no conditions, one IdP per account. For the
Microsoft Entra ID specifics see `docs/ENTRA_SSO_SCIM_SETUP.md`; for the entitlement
mechanism see `docs/ENTERPRISE_EDITION.md`.*
