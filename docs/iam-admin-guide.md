# IAM admin guide

A practical reference for account admins working with the current Kortix
IAM V2 system. V2 is role-based and table-driven; the old V1 policy
engine is not mounted.

## Mental model

IAM V2 has two role axes:

| Axis | Roles | Applies to |
|---|---|---|
| Account | `owner`, `admin`, `member` | Account-level actions such as billing, members, groups, tokens, audit, and project creation. |
| Project | `manager`, `editor`, `viewer` | Project-level actions such as project reads/writes, sessions, triggers, deployments, and project member management. |

Access comes from these tables:

| Table | Purpose |
|---|---|
| `account_members` | Account membership, account role, super-admin flag, and account-wide MFA gate. |
| `project_members` | Direct per-user project role. |
| `account_groups` | Account-local groups. |
| `account_group_members` | User membership in groups. |
| `project_group_grants` | Group-to-project grants with a project role and optional expiry. |

The engine does not read `iam_policies`, custom roles, policy scopes,
deny rules, permission boundaries, IP conditions, per-policy MFA
conditions, strict IAM mode, external grants, project groups, break-glass,
drift reports, analytics, simulators, or policy templates.

Those historical tables may still exist in the database for migration
safety, but the current API does not write to them or evaluate them.

## Principals

| Kind | Notes |
|---|---|
| Member | A human user in `account_members`. |
| Group | An `account_groups` row; every user in `account_group_members` inherits the group's project grants. |
| PAT | A personal access token. Project-scoped PATs can only act on their bound project and are rejected on account routes. |
| Service account | A non-human identity managed through the service-account IAM endpoints. |

## Role behavior

Account roles:

| Role | Summary |
|---|---|
| `owner` | Full account control, including owner-only billing/account deletion and super-admin grants. |
| `admin` | Account administration, members, groups, tokens, audit, and project creation. |
| `member` | Baseline account reads only. Project access still requires a direct project role or group grant. |

Project roles:

| Role | Summary |
|---|---|
| `manager` | Full project control, including delete and project member management. |
| `editor` | Read/write project content, deploy, run sessions, and manage triggers. |
| `viewer` | Read-only project access. |

Owners and admins receive implicit `manager` access to every project in
the account. Plain members do not; they need a direct `project_members`
row or a `project_group_grants` row through one of their groups.

When multiple project roles apply, the strongest role wins:

`manager > editor > viewer`

Expired direct memberships and group grants are ignored by authorization
queries as soon as `expires_at` is in the past. The expiry sweeper is for
audit cleanup and follow-up bookkeeping, not for correctness.

## Common workflows

### Give an engineering group editor access to a project

1. Create or reuse an account group.
2. Add engineers to the group.
3. Grant that group `editor` on the target project.
4. Confirm the result with the member effective-access endpoints.

V2 project grants are group-to-project rows. There is no separate
"project group" resource and no policy scope grammar.

### Give a user direct access to one project

1. Add the user to the account as a member.
2. Add or update their `project_members` row for that project.
3. Pick `viewer`, `editor`, or `manager`.
4. Use the effective-access endpoint when debugging the final role.

### Lock down a project-scoped PAT

1. Mint the PAT with `project_id` set.
2. Use it only on routes whose authorization target is that same project.
3. Account-level routes are rejected for project-scoped PATs.

PATs bypass account-wide browser MFA enforcement, but they do not bypass
project scoping or role checks.

### Enforce MFA for browser sessions

Use the account-wide MFA setting. When enabled, JWT/browser requests must
have Supabase `aal2`. PATs are exempt. There are no per-policy MFA
conditions in V2.

## Authorization order

1. Resolve the user as an account member.
2. Reject project-scoped PATs when the request is account-level or targets
   a different project.
3. Allow super-admins.
4. Enforce account-wide MFA for browser/JWT requests when enabled.
5. For account actions, check the account role.
6. For project actions, derive the effective project role from:
   `owner/admin` implicit manager, direct project membership, and group
   project grants.
7. Check whether the resulting role grants the requested action.

V2 has no deny precedence because it has no deny policies.

## REST surface

The current mounted account IAM routes are:

| Endpoint | Purpose |
|---|---|
| `GET /v1/accounts/:accountId/iam/groups` | List groups. |
| `POST /v1/accounts/:accountId/iam/groups` | Create a group. |
| `GET /v1/accounts/:accountId/iam/groups/:groupId` | Read one group. |
| `PATCH /v1/accounts/:accountId/iam/groups/:groupId` | Update a group. |
| `DELETE /v1/accounts/:accountId/iam/groups/:groupId` | Delete a group. |
| `GET /v1/accounts/:accountId/iam/groups/:groupId/members` | List group members. |
| `POST /v1/accounts/:accountId/iam/groups/:groupId/members` | Add group members. |
| `DELETE /v1/accounts/:accountId/iam/groups/:groupId/members/:userId` | Remove a group member. |
| `GET /v1/accounts/:accountId/iam/groups/:groupId/project-grants` | List group project grants. |
| `PATCH /v1/accounts/:accountId/iam/members/:userId/super-admin` | Toggle super-admin. |
| `GET /v1/accounts/:accountId/iam/members/:userId/groups` | List a member's groups. |
| `GET /v1/accounts/:accountId/iam/members/:userId/project-access` | List a member's project access. |
| `GET /v1/accounts/:accountId/iam/members/:userId/effective` | Probe effective access. |
| `POST /v1/accounts/:accountId/iam/members/:userId/effective:batch` | Batch effective-access probes. |
| `GET /v1/accounts/:accountId/iam/mfa-required` | Read account-wide MFA enforcement. |
| `GET /v1/accounts/:accountId/iam/mfa-required/preview` | Preview MFA enforcement impact. |
| `PATCH /v1/accounts/:accountId/iam/mfa-required` | Update account-wide MFA enforcement. |
| `GET /v1/accounts/:accountId/iam/scim/tokens` | List SCIM tokens. |
| `POST /v1/accounts/:accountId/iam/scim/tokens` | Create a SCIM token. |
| `DELETE /v1/accounts/:accountId/iam/scim/tokens/:tokenId` | Revoke a SCIM token. |
| `GET /v1/accounts/:accountId/iam/sso/provider` | Read SSO provider config. |
| `DELETE /v1/accounts/:accountId/iam/sso/provider` | Delete SSO provider config. |
| `GET /v1/accounts/:accountId/iam/sso/mappings` | List SSO group mappings. |
| `POST /v1/accounts/:accountId/iam/sso/mappings` | Create SSO group mapping. |
| `DELETE /v1/accounts/:accountId/iam/sso/mappings/:mappingId` | Delete SSO group mapping. |
| `GET /v1/accounts/:accountId/iam/session-policy` | Read session policy. |
| `PATCH /v1/accounts/:accountId/iam/session-policy` | Update session policy. |
| `GET /v1/accounts/:accountId/iam/sessions` | List sessions. |
| `POST /v1/accounts/:accountId/iam/sessions/:sessionId/revoke` | Revoke a session. |
| `GET /v1/accounts/:accountId/iam/pat-policy` | Read PAT policy. |
| `PATCH /v1/accounts/:accountId/iam/pat-policy` | Update PAT policy. |
| `GET /v1/accounts/:accountId/iam/service-accounts` | List service accounts. |
| `POST /v1/accounts/:accountId/iam/service-accounts` | Create a service account. |
| `POST /v1/accounts/:accountId/iam/service-accounts/:saId/disable` | Disable a service account. |
| `DELETE /v1/accounts/:accountId/iam/service-accounts/:saId` | Delete a service account. |

## Removed V1 surfaces

These endpoints and concepts are intentionally not mounted in V2:

| Removed surface | Current replacement |
|---|---|
| Policies and policy templates | Fixed account and project roles. |
| Custom roles | Built-in roles only. |
| Permission boundaries | Assign a lower account or project role. |
| Strict IAM mode | V2 always uses the current role tables. |
| Policy conditions (`ip_cidrs`, `require_mfa`) | Account-wide MFA only; no IP conditions. |
| Deny policies | No deny layer. |
| Project groups | Direct group-to-project grants. |
| External grants | Account membership and group grants. |
| Break-glass | Super-admin toggle. |
| Drift reports, analytics, simulator | Effective-access and batch probe endpoints. |

## Troubleshooting

**A user cannot see a project they should have access to.**

Check the member's effective project access. For plain account members,
confirm either a direct `project_members` row or an unexpired group grant
through `project_group_grants`. Owners and admins should have implicit
`manager` access to all account projects.

**A PAT is unexpectedly denied.**

Check whether the PAT is project-scoped. A project-scoped PAT is denied
on account routes and on any other project. If the target project is
correct, debug the minter's account/project role like a normal user.

**MFA enforcement blocked a browser session.**

Confirm the request is using a Supabase JWT with `aal2`. PAT requests are
exempt. The MFA preview endpoint shows which members are affected before
turning enforcement on.

**A group grant is not applying.**

Confirm the user is in the group, the group has a grant to the target
project, and the grant has not expired.
