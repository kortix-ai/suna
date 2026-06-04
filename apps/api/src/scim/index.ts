// SCIM 2.0 protocol surface for Okta / Azure AD / JumpCloud / etc.
//
// Mounted at /scim/v2/accounts/:accountId/* — the URL carries the tenant
// so the IdP configures its base URL once. scimAuth middleware validates
// the bearer token and ensures it belongs to the same account.
//
// What we implement (v1):
//   - /ServiceProviderConfig (capabilities discovery)
//   - /Users: GET (list + filter by userName), GET/:id, POST, PATCH, DELETE
//   - /Groups: GET (list), GET/:id, POST, PATCH, DELETE (member add/remove via PATCH)
//
// What we deliberately skip in v1:
//   - PUT (most IdPs prefer PATCH; PATCH is sufficient for Okta + Azure AD)
//   - /Schemas and /ResourceTypes (most IdPs hardcode knowledge of the spec)
//   - Pagination beyond the default page (small directories fit; revisit if needed)
//   - Full filter grammar — only `userName eq` / `id eq` / `displayName eq` are
//     supported, which covers the request patterns Okta and Azure AD actually use.
//
// This file is the orchestrator: it wires the route modules in their original
// registration order. The router instance, the `scimAuth` middleware (applied
// in its original position before any routes), and the shared helpers all live
// in `./app`, which every route module imports first.

import { accounts } from '@kortix/db';
import { scimRouter } from './app';

// Register routes in their original order (side-effect imports).
import './service-provider';
import './users';
import './groups';

// `accounts` import kept only so future endpoints (e.g. /Me) can resolve
// the account by URL without re-importing. Silences unused-import lints.
void accounts;

export { scimRouter };
