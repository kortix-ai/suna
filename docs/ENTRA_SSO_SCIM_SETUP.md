# Microsoft Entra ID (Azure AD) → Kortix: SSO + Directory Sync

How to connect a Microsoft Entra ID (Azure AD) tenant to a Kortix account so that:

- **Users sign in with SSO** (SAML), and
- **Users & Groups sync from Entra** (SCIM), and
- **Entra group membership drives Kortix access** (a group → a Kortix IAM group → a project role).

This is the setup an enterprise (e.g. essentia-inc.com) runs once. Everything is
account-scoped and gated on the `sso` entitlement.

---

## How the model works (read this first)

Two independent channels, joined by **IAM groups**:

```
                    ┌── SAML (auth) ──────────► "who is signing in" (+ live group claim)
  Entra tenant ─────┤
                    └── SCIM (provisioning) ──► "who exists / who is in which group" (pushed)

  Entra group ──(mapping: claim value → Kortix group)──► Kortix IAM group
  Kortix IAM group ──(project grant: group → role)────► role on a project
  role on a project ──(authorizeV2)──────────────────► what the user may do
```

- **SAML** authenticates the user and, on each login, carries their groups in a
  claim (`memberOf` on Entra). Just-in-time (JIT) sync provisions the member and
  reconciles their IAM group memberships from that claim.
- **SCIM** lets Entra *push* user + group changes proactively (create, update,
  deactivate, group membership) instead of waiting for a login.
- **Group → role** is the deliberate admin step: you map an Entra group to a
  Kortix IAM group, then grant that IAM group a role on specific projects. A
  synced group confers **no** access until you grant it a role — this is the
  opinionated, no-surprise default.

Access changes are eventually consistent within **~15 s** (IAM cache TTL) after a
revoke; grants that ride a fresh login are immediate.

---

## Prerequisites

- Kortix account with the **`sso` entitlement** (enterprise tier). Without it the
  provider/mapping/SCIM-token endpoints return `402`.
- **Account owner or admin** on the Kortix side (these are account-scoped IAM
  actions).
- **Global Administrator / Application Administrator** on the Entra side.
- *(Self-hosted operators only, advanced path)* Access to your Kortix control
  plane's **Supabase project** — SAML metadata is registered with Supabase Auth,
  which validates assertions (see Part A). Not needed for the self-serve path;
  everything a customer needs comes from the SAML SSO card.

Kortix API base below is written as `https://<api>` and all admin calls use a
Kortix account bearer (owner/admin JWT or PAT).

---

## Part A — SAML single sign-on

Kortix delegates SAML assertion validation to Supabase Auth, so the IdP metadata
is registered **with Supabase**, and Kortix stores the resulting provider id.

1. **In Entra**: create an **Enterprise Application** → *Single sign-on* → **SAML**.
   - **Identifier (Entity ID)** and **Reply URL (ACS)**: copy both values from the
     **Service provider details** section of the SAML SSO card (Account →
     **Settings** → **Identity & directory** → **SAML SSO** — visible before you
     configure anything, with a copy button on each). *(Operator-only advanced
     path: these also live in the Supabase project's SAML SSO configuration —
     Supabase → Authentication → SSO — for self-hosted deployments; customers
     should always use the SSO card.)*
   - Download the **App Federation Metadata XML** (or copy the metadata URL).

   > **Is this URL safe to share with your IdP admin?** Yes. The Entity ID /
   > metadata URL is a public-by-design SAML endpoint of the auth layer — every
   > IdP must be able to fetch it to complete federation, and it exposes no
   > account data. If you configure a custom auth domain later, this URL can be
   > branded to it.

2. **Register the provider — pick one path:**

   **(A) Self-serve, in the dashboard (recommended).** Account → **Settings** →
   **SAML SSO** → **Configure** → **Import IdP metadata**. Paste the metadata XML
   (or its URL), set the display name, primary domain, and group claim, and save.
   Kortix registers the IdP with Supabase server-side and stores the resulting
   provider id — you never touch Supabase. (API:
   `POST /v1/accounts/{accountId}/iam/sso/provider/from-metadata` with
   `{ metadata_xml | metadata_url, name, primary_domain, group_claim_name, auto_create_members }`.)
   One IdP per account — remove the existing one to re-import.

   **(B) Advanced / operator path.** Register with Supabase yourself, then paste
   the UUID into the same dialog under **Advanced: Supabase UUID**:
   ```
   supabase sso add --type saml --metadata-url "<entra federation metadata url>" \
     --domains essentia-inc.com
   # → SSO provider UUID
   PUT https://<api>/v1/accounts/{accountId}/iam/sso/provider
   { "supabase_sso_provider_id": "<uuid>", "name": "Azure AD",
     "primary_domain": "essentia-inc.com", "group_claim_name": "memberOf",
     "auto_create_members": false }
   ```

   Either way: `primary_domain` lets the sign-in page route `you@essentia-inc.com`
   straight to this IdP, and `group_claim_name` MUST match the claim Entra actually
   emits (Part B).

> **auto_create_members** — leave `false` for strict, admin-provisioned access:
> only users an admin (or SCIM) has already added get synced. Set `true` to let
> any successful SSO sign-in from `primary_domain` self-provision a baseline
> `member` (they still get **no** project access until a group grant applies).

> **Email claim — the #1 Entra gotcha.** Entra maps the SAML email to `user.mail`,
> which is **empty** for accounts without a mailbox (e.g. any `*.onmicrosoft.com`
> user, or unlicensed accounts). An empty email means the user signs in but can't
> be identified. In the Enterprise App → **Single sign-on → Attributes & Claims**,
> edit the `…/emailaddress` claim and set its **Source attribute** to
> **`user.userprincipalname`** — the UPN is always populated and email-formatted.

> **You do NOT touch Supabase's attribute mapping.** Kortix registers the IdP with
> the group-claim `attribute_mapping` automatically (from `group_claim_name`), so
> the group values reach the token. If you registered a provider via the operator
> `supabase sso add` path, re-save the SSO config once in the dashboard and Kortix
> will (re)apply the mapping for you.

---

## Part B — emit group claims from Entra

Entra does not send groups by default. In the Enterprise App → *Single sign-on* →
**Attributes & Claims** → **Add a group claim**:

- Choose which groups to emit (Security groups / Groups assigned to the app —
  prefer the latter to keep the claim small).
- **Source attribute**: by default Entra emits group **Object IDs (GUIDs)**, not
  names — so a mapping's *claim value* is the group's **Object ID** unless you
  change this. To map by readable **name** instead, you must (a) set the claim to
  **"Groups assigned to the application"**, (b) pick source attribute **"Cloud-only
  group display names"** (it is greyed out for "Security groups"), and (c) **assign
  each group to the enterprise app**. ⚠️ **Assigning a *group* to an app requires
  Entra ID P1/P2** — on the **Free** plan you can only assign users, so Free-tier
  tenants are **GUID-only**. Either way works: Kortix matches GUIDs and names
  identically (case/space-insensitive) — GUID mapping is actually more robust since
  IDs never change.
- Ensure the claim **name** is what you set as `group_claim_name` (default
  `memberOf`).

Whatever Entra emits (GUID or name) is the **claim value** you map in Part C.
Matching is case- and whitespace-insensitive, so display-name casing is forgiving;
GUIDs match regardless.

---

## Part C — map Entra groups → Kortix groups → project roles

1. **Create the Kortix IAM groups** (or reuse existing) — these are your
   "departments" (Marketing, Engineering, …). Via the Members → Departments UI or
   the groups API.

2. **Map each Entra group claim value → a Kortix group**:
   ```
   POST https://<api>/v1/accounts/{accountId}/iam/sso/mappings
   { "claim_value": "<Entra group GUID or name>", "group_id": "<kortix group id>" }
   ```
   One claim value maps to exactly one Kortix group (to fan a group across many
   grants, attach several project grants to that one Kortix group).

3. **Grant the Kortix group a role on the projects it should reach** (Members →
   Resource access / project grants): e.g. *Marketing → editor on project X*. This
   is what turns membership into permissions.

That's the whole chain. On the user's next SSO login (or SCIM push), their Entra
groups reconcile their Kortix group memberships, and the project grants confer the
role. Remove them from the Entra group and access is revoked on the next
sync (within the ~15 s cache window).

---

## Part D — SCIM provisioning (push users & groups)

SCIM lets Entra provision proactively rather than only at login — recommended so
deactivations and group changes propagate without waiting for the user to sign in.

1. **Mint a SCIM token** (store the plaintext — shown once):
   ```
   POST https://<api>/v1/accounts/{accountId}/iam/scim/tokens
   { "name": "Entra provisioning" }
   → { "token": "…", "scim_base_url": "/scim/v2/accounts/{accountId}" }
   ```

2. **In Entra** → Enterprise App → **Provisioning** → *Automatic*:
   - **Tenant URL**: `https://<api>/scim/v2/accounts/{accountId}` (from
     `scim_base_url`).
   - **Secret Token**: the SCIM token from step 1.
   - **Test Connection** (Entra probes `/ServiceProviderConfig` + a filtered
     `/Users` query — both implemented).
   - Map attributes: `userName` → user email, keep `externalId`. Assign users/groups
     to the app and **Start provisioning**.

SCIM behavior worth knowing:
- **Users**: create by email; a not-yet-signed-up user is provisioned as an invite
  and reports `active:false` until they sign in.
- **Deactivate** (`PATCH active:false` or DELETE): removes the account membership
  and busts their cache. The **last owner cannot be deactivated** (guarded).
- **Groups**: create + membership `PATCH` (Entra's add/remove and replace ops) map
  onto Kortix IAM group membership; grant those groups project roles (Part C).

---

## Verification checklist

These mirror the automated integration tests
(`apps/api/src/__tests__/integration-iam-sso-sync.test.ts` +
`integration-iam-engine.test.ts`). Verify against your live tenant:

- [ ] A user in a mapped Entra group signs in via SSO → lands with the expected
      role on the expected project.
- [ ] The same user, **removed** from the Entra group in Entra → loses that access
      on the next login/sync (≤ ~15 s).
- [ ] A user in an **unmapped** group gets a baseline member (if
      `auto_create_members`) but **no** project access.
- [ ] SCIM **Test Connection** succeeds in Entra.
- [ ] SCIM **deactivate** removes the user; they can no longer act.
- [ ] With `auto_create_members:false`, an unprovisioned SSO user is **not** auto-joined.

---

## Known behaviors & caveats

- **Revoke lag ≤ ~15 s** — the IAM authorization cache TTL. A removed member or
  group grant stops working within one TTL window across replicas.
- **Deactivation = removal.** `active:false` removes the membership (not a
  reversible soft-flag). Re-adding a user in Entra re-provisions them via SCIM
  `POST`; their prior *role grants* are not automatically restored — grants live
  on the Kortix group, so re-adding them to the group restores access.
- **Group → role is explicit.** Synced groups never grant access on their own; an
  admin must grant the Kortix group a project role. This is intentional
  (deny-by-default, no surprise access).
- **Claim mismatch fails safe.** If `group_claim_name` doesn't match what Entra
  emits, or a claim value has no mapping, the user simply gets no groups (no
  error, no partial access). Double-check the claim name if groups aren't syncing.
- **One IdP per account** in v1.
