# Kortix Enterprise

Kortix is open source under the [Apache License 2.0](../LICENSE). The code in
directories named `ee` is the exception. It is licensed under the
[Kortix Enterprise License](LICENSE).

## What is Enterprise

Enterprise is four features. They match the `sso`, `scim`, `rbac` and
`auditAccess` entitlements in `apps/api/src/billing/services/plan-catalog.ts`.

| Feature | Server code |
|---|---|
| SAML single sign-on | `apps/api/src/accounts/iam/ee/sso.ts`, `sso-provisioning.ts`, `apps/api/src/iam/ee/sso-sync.ts`, `apps/api/src/repositories/ee/sso.ts` |
| SCIM directory provisioning | `apps/api/src/ee/scim/`, `apps/api/src/accounts/iam/ee/scim-tokens.ts`, `apps/api/src/repositories/ee/scim.ts` |
| Custom roles, policies and groups | `apps/api/src/accounts/iam/ee/custom-roles.ts`, `custom-roles-policy.ts`, `groups.ts`, `apps/api/src/projects/routes/ee/group-grants.ts` |
| Audit log access, export and webhooks | `apps/api/src/accounts/ee/audit.ts`, `apps/api/src/shared/ee/audit-webhooks.ts` |

Every one of these files starts with the header
`// SPDX-License-Identifier: LicenseRef-Kortix-Enterprise`, so the license stays
on a file that is copied out of its directory. `tests/unit/ee-license-headers.test.ts`
fails when an `ee` file lacks it, or a file outside `ee` claims it.

Each feature is also gated at run time by its entitlement: a route answers `402
entitlement_required`, the SCIM API refuses the token, and audit webhooks stop
delivering, unless the account is Licensed, in Demo, or the deployment holds a
valid license key.

Everything else is Apache 2.0, including:

- the database schema;
- the role and policy engine that enforces built-in and custom roles
  (`apps/api/src/iam/`), because every plan uses the built-in roles;
- the audit trail itself (Kortix records audit events on every plan);
- the web screens and the `@kortix/sdk` calls for these features, which do
  nothing without an Enterprise server;
- organization branding, which is on for every plan.

## What is free

- **Development, testing and evaluation.** Run, read and change the `ee/` code
  without a subscription, as long as it is not production use (`ee/LICENSE`,
  section 2).
- **The Enterprise demo.** An owner or admin can turn on the demo in Settings >
  Billing. The account shows "Demo" wherever Enterprise appears. Use it for
  evaluation, not for production.
- **Forks.** A copy or fork of the repository may keep the `ee/` directories,
  with `ee/LICENSE` intact (`ee/LICENSE`, section 5).

## What needs a subscription

Production use of any `ee/` code: real users or real data in the operations of
a business. This holds on a fork and on a modified copy, and whether or not a
license key check runs (`ee/LICENSE`, section 3). The commercial terms are the
[Kortix Enterprise Subscription Terms](https://kortix.com/legal?tab=enterprise).

## Turn it on

- **Kortix Cloud:** a license contract switches the account to Licensed. Talk to
  sales in Settings > Billing, or see [kortix.com/enterprise](https://kortix.com/enterprise).
- **Self-host:** Kortix issues a license key with the subscription. Set it with
  `kortix self-host configure --license-key <key>`, or set `KORTIX_LICENSE_KEY`
  in the API environment. The API logs the licensee and the end date at boot. A
  missing, invalid or expired key leaves the Enterprise features off. Each
  term gets a new key.

## Can I build my own?

Yes. Apache 2.0 lets you write your own SSO, SCIM, roles or audit export for
the core. Write it yourself: copying or adapting `ee/` code into it makes it
Enterprise Software under `ee/LICENSE`, section 4. Kortix does not merge pull
requests that rebuild an `ee/` feature in the Apache core.

## For contributors

- Code that only serves the four features above goes in an `ee` directory next
  to the module it belongs to (`accounts/iam/ee/`, `repositories/ee/`,
  `shared/ee/`), or in `apps/api/src/ee/` for a whole module, and starts with
  the SPDX header above.
- Gate every new Enterprise route with `requireEntitlement(c, accountId, '<key>')`.
- Core code calls `ee/` only through its `register…Routes()` functions, the SSO
  sign-in checks and the audit webhook worker's timer. Shared logic that core
  needs stays in core.
- Kortix does not merge outside pull requests into `ee/`: the Enterprise
  License gives Kortix no rights to a contributor's code. Contributions to the
  Apache core are licensed under Apache 2.0, section 5.
