---
recorded: 2026-10-01T12:37:01Z
incident_date: 2026-10-01
---
# A server-side check about a member must not run the browser MFA gate; ask it with the request's level only for the caller's own request

**Rule:** Account-wide MFA (`authorize` step 6, `mfaGateBlocks`) guards a person's own browser requests. Two cases:
- **A check about a member,** where nobody is stepping up in a browser right now: build the actor with the gate satisfied. Examples: may this member read the project, may this session use this key, may this grantee receive a key. This is `memberMayReadProject`'s default in `apps/api/src/secrets/account-resource.ts`.
- **A route that authorizes the caller's own request through such a helper alone:** pass that request's level (`{ mfaAal: c.get('mfaAal') }`).

A bare `actorForUser(userId, accountId)` has no level. In an account that requires MFA, it refuses everyone except a super admin.

**Trigger surface:**
- `secrets/account-resource.ts`: `listUsableGatewaySecrets`, `resolveProjectSharedProviderSecrets`, `resolveDefaultCodexAccountSecret`, `resolveSessionProviderSecrets`;
- `accounts/secret-resources.ts`;
- the gateway's key resolution (`llm-gateway/resolution/resolve-candidates.ts`);
- any helper that calls `authorize(actorForUser(...))` outside a request.

**Incident:** 2026-10-01, found in a live Teams test on dev, in an account with "Require MFA" on. A member's Teams channel turns ran as that member. They never reached the ChatGPT login shared with the whole project. The audit log showed `secret.consumer.missing` for `CODEX_AUTH_JSON` on every turn, and each turn failed with "Connect Codex to use this model".

The same check also blocked members of an MFA-required account in two other ways:
- they could not be granted a ChatGPT login;
- they could not list logins for a project, even at aal2.

Fixed in the PR that adds this entry.

**Enforcement:** `apps/api/src/__tests__/integration-usable-gateway-secrets.test.ts` → "an account that requires MFA", which runs the real `authorize` on a fresh MFA-required account:
- a member's session reaches the shared login;
- a member with no project role still gets nothing;
- a request with aal1 or no level is refused, and aal2 passes.
