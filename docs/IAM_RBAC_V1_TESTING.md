# IAM / RBAC v1 — how to test it (dummy data included)

Two things to prove:

1. **The inheritance pyramid** — resources (secrets + connectors) live on **agents**, never on people directly. You assign an **agent** to a member or a department, and they inherit every secret + connector that agent declares. No per-person secret sharing.
2. **Azure AD / Entra directory-sync** — an Entra group claim on SSO login provisions the member, syncs their Kortix group membership, and the group's project grant confers a role — all enforced by `authorizeV2`. Remove them from the Entra group and access disappears on next login.

Both have **self-contained, self-cleaning integration tests that seed their own dummy data** against your local DB. That's the fastest proof. Manual CLI + dashboard walkthroughs follow for a hands-on check.

---

## 1. The 60-second automated proof

From `apps/api` (Node 22; secrets come from dotenvx):

```bash
cd apps/api
KORTIX_URL=https://localhost dotenvx run --quiet -- bun test \
  src/__tests__/integration-agent-inheritance.test.ts \
  src/__tests__/integration-iam-sso-sync.test.ts
```

Expected: **12 pass, 0 fail**. Both files seed dummy rows (dummy secrets + agent grants for the pyramid; a fresh account + SSO provider + group + mapping for Azure) and delete them in `afterAll`, so they leave no residue.

What each asserts:

**`integration-agent-inheritance.test.ts`** (the pyramid)
- A secret the agent **declares** resolves for an assigned member **even when that secret is share-restricted to someone else** — inheritance bypasses per-user share scope for declared names.
- Reserved (`KORTIX_*`) and connector-scoped secrets are **never** leaked by inheritance.
- Assignment must be **deliberate**: an unscoped agent grants nobody; only members named on the grant (or in an assigned department) inherit.
- Department assignment works: a member of an assigned group inherits.
- `resolveAssignedAgentNames` / `unionDeclaredResources` return exactly the union of what the assigned agents declare, with provenance.

**`integration-iam-sso-sync.test.ts`** (Azure/Entra)
- First SSO login JIT-provisions the member, syncs the mapped Entra group, and `authorizeV2` then **allows** the project action.
- Remove the claim (removed from the Entra group) → membership revoked, access **denied** on next login.
- Case-insensitive claim matching; an unmapped claim confers nothing; `autoCreateMembers=false` refuses to provision uninvited users.

---

## 2. Manual walkthrough — the pyramid (CLI)

The `kortix grants` command wraps the same `/projects/:id/resource-grants` routes the dashboard uses. It's the CLI edge of the pyramid.

```bash
# See what's grantable + who's assigned to what.
# Agents show the blast radius: "N secrets · all connectors" = what an assignee inherits.
kortix grants ls

# Assign an agent to a member by email (resolved to a user-id for you).
# They now inherit every secret + connector that agent declares.
kortix grants assign support-bot --to alice@corp.com

# Assign an agent to a DEPARTMENT (group) — everyone in it inherits.
kortix grants assign support-bot --to <group-id> --group

# Scope a specific secret to a member directly (the share model, not the pyramid).
kortix grants assign DB_URL --type secret --to alice@corp.com

# Remove a grant.
kortix grants revoke <grant-id>

# Machine-readable for scripting / assertions.
kortix grants ls --json
```

Prerequisite: a linked project (`kortix projects link`) whose `kortix.toml` declares an agent with a `[[agents]].scope` (its `env` / `connectors`). `kortix grants ls` lists those agents as grantable and shows each agent's declared secret/connector counts.

**What to verify:** after `assign`, that member's next session picks up the declared secrets/connectors (and only those), even if the secret is otherwise restricted. That's the exact behavior the integration test asserts — the CLI just drives it by hand.

---

## 3. Manual walkthrough — the pyramid (dashboard)

- **Step 1 — put resources on an agent.** Agents section → pick an agent → **Access scope** card. Managers can now edit **Secrets** and **Connectors** here (All · Specific · None); it writes the `[[agents]].env` / `.connectors` allowlists to `kortix.toml` for you — no hand-editing. (Editing `kortix.toml` directly still works and is equivalent.)
- **Step 2 — assign people.** **Members → Resource access** assigns agents/skills to members/departments — the dashboard twin of `kortix grants assign`. Whoever you assign inherits exactly the secrets + connectors from step 1.
- **Secret / connector modals** now offer only **Project-wide** or **Private** — the direct "specific members/departments" picker is gone. Targeted access flows through agent assignment. (A legacy secret still stored as a direct member share shows an amber "switch it" note.)

---

## 4. Manual walkthrough — Azure / Entra (live wiring)

The automated test above proves the sync + authorization logic with a fake Entra JWT. To wire a **real** Entra tenant (SAML app, group claims, SCIM), follow the runbook:

- **[ENTRA_SSO_SCIM_SETUP.md](./ENTRA_SSO_SCIM_SETUP.md)** — SAML SSO, group-claim emission, group→role mapping, and SCIM provisioning, with a verification checklist.

To simulate an Entra login without a tenant, call `syncSsoMembership({ userId, email, jwtPayload })` with `jwtPayload.app_metadata = { provider_id, memberOf: ['Your-Group-Claim'] }` — exactly what the integration test does.

---

## Design reference

- **[IAM_RBAC_V1_PLAN.md](./IAM_RBAC_V1_PLAN.md)** — the phased plan this implements.
- **[IAM_INHERITANCE_PLAN.md](./IAM_INHERITANCE_PLAN.md)** — the inheritance-pyramid design.
