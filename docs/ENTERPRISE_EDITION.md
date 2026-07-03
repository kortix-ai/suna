# Enterprise Edition — what's gated, and how

Kortix is source-available under the [Elastic License 2.0](../LICENSE): free to
self-host, modify, and run in production. ELv2 also explicitly permits gating
specific functionality behind a license key ("you may not move, change, disable,
or circumvent the license key functionality"). This doc is the single source of
truth for exactly what that gate covers today — so sales copy, docs, and code
can't drift apart.

**The mechanism:** every account resolves to a billing `tier` (`none` / `free`
/ `pro` / `per_seat` / … / `enterprise`). Each tier carries a static
`TierEntitlements` object (`apps/api/src/types.ts`); only the sales-assigned
`enterprise` tier has every flag on. Routes call
`requireEntitlement(c, accountId, '<key>')` (`apps/api/src/accounts/iam/helpers.ts`)
to fail closed with a `402 entitlement_required` when the account's tier lacks
the flag. An account with no billing row resolves to `none` — no entitlements,
ever, unprovisioned-safe by default.

## Community (every self-serve and self-hosted tier)

Everything not listed under Enterprise below — the full agent/skill/connector/
session/memory product, hardware-isolated sandboxes, change-request workflow,
unlimited self-hosted use per the ELv2 terms. Specifically, on the identity/
governance surface:

- **Preset roles** — Owner / Admin / Member (account) and Manager / Editor /
  User (project). Assignable to any member, free on every tier
  (`role-presets.ts`; assignment lives outside the entitlement-gated IAM v1
  surface entirely).
- **Audit recording** — every governed action (IAM changes, agent tool/connector
  calls with their risk verdict, etc.) is captured always, on every tier.
  Community never loses the underlying trail.

## Enterprise (sales-assigned `enterprise` tier only)

| Entitlement key | Gates | Why it's Enterprise |
|---|---|---|
| `sso` | SAML SSO config, JIT provisioning, group-claim mapping (`accounts/iam/sso.ts`) | Identity federation is the standard enterprise trigger across this category (Documenso, n8n, GitLab, Onyx, Cal.com all gate SAML the same way) |
| `scim` | SCIM 2.0 directory provisioning — token mint/revoke + `/scim/v2/*` (`accounts/iam/scim-tokens.ts`, `middleware/scim-auth.ts`) | Pairs with SSO; automated user lifecycle is an IT/security-team need, not an individual one |
| `rbac` | **Creating/growing** custom RBAC state: custom roles + their permission sets, policy bindings (`accounts/iam/custom-roles.ts`), groups + membership adds (`accounts/iam/groups.ts`), and group→project grant create/re-role (`projects/routes/r7.ts`) | Preset roles cover the common cases for free; defining your own roles/policies and grouping members is the governance layer regulated orgs actually need |
| `auditAccess` | **Reading, exporting, and streaming** the audit trail — account audit log + export, webhook create/update (`accounts/audit.ts`), webhook **delivery** (`shared/audit-webhooks.ts`, the data plane), and the per-session agent-action **history** (`projects/routes/r7.ts`) | Recording is universal (see above); *who gets to look at it* — and pipe it into a SIEM — is the compliance feature |

**The approval control plane is never paywalled.** Write/destructive connector
actions default to `require_approval` on every tier (`executor/policy.ts`), so
`GET /sessions/:id/audit` never returns a 402 — for unentitled accounts it
degrades to *unresolved pending approvals only* (`audit_access: false` in the
response) so the launcher can always see and resolve what's blocking the run.
Only the historical allowed/denied trail is Enterprise.

**Revocation is never paywalled.** Deleting a custom role, revoking a policy,
deleting a group, removing a group member, detaching a group grant, or deleting
an audit webhook all work on every tier — a downgraded account must always be
able to see and clean up state it can no longer manage. Reads stay open for the
same reason (they return empty for accounts that never had Enterprise).

**Existing grants keep enforcing after a downgrade** (standard open-core
practice — gate management, not evaluation). The IAM engine honors whatever
custom policies/groups exist until an admin removes them; what a downgraded
account can't do is mint new ones. The one deliberate exception is audit
webhook delivery, which checks the live entitlement per event — leftover
webhook rows stop streaming immediately.

Nothing else in the product is currently entitlement-gated. Categories common
elsewhere in this space (HA/clustering, dedicated single-tenant infra,
white-labeling, LDAP, tiered data retention, air-gap-specific code) aren't yet
built as Kortix features at all, so there's nothing to gate — self-hosting the
whole product already *is* your air-gapped, dedicated, single-tenant
deployment. If/when any of those become real product surfaces, they get a new
`TierEntitlements` key here, not a separate mechanism.

## Adding a new gate

1. Add the key + a one-line doc comment to `TierEntitlements` in
   `apps/api/src/types.ts`.
2. Set it in `NO_ENTERPRISE` / `ALL_ENTERPRISE` in
   `apps/api/src/billing/services/tiers.ts`.
3. Add a human label to `ENTITLEMENT_LABEL` in
   `apps/api/src/accounts/iam/helpers.ts` (the compiler enforces this — it's a
   `Record<keyof TierEntitlements, string>`).
4. Guard the route(s): `const denied = await requireEntitlement(c, accountId, '<key>'); if (denied) return denied;`
5. Update the table above.

## Previewing the gate without a contract

Any account can flip `PUT /{accountId}/iam/enterprise-demo` to unlock every
entitlement for itself — a self-serve, clearly-labeled preview so prospects
(and we, dogfooding) can see the real surface before signing. It is **not**
behind `requireEntitlement` by design; production use of the resulting access
still requires a signed Enterprise agreement, same as always.
