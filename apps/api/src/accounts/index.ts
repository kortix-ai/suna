// Orchestrator for the accounts router. Wires middleware + sub-router mounts +
// route modules in the SAME order as the original single-file router. The router
// instance + shared schemas/helpers live in ./core/app (a leaf module); each
// ./core/<group> module exports a register*() function that attaches its routes
// to that instance. We call them here (after middleware + mounts) so the final
// registration order is byte-identical to the original file.
import { accountsRouter } from './core/app';
import { supabaseAuth } from '../middleware/auth';
import { accountSessionGate } from '../iam/session-gate';
import { iamRouter } from './iam';
import { auditRouter } from './audit';
import { registerTokenRoutes } from './core/tokens';
import { registerAccountRoutes } from './core/accounts';
import { registerMemberRoutes } from './core/members';

accountsRouter.use('/*', supabaseAuth);
// Enforce per-account session policies (max lifetime / idle timeout /
// force-logout) on every authenticated, account-scoped request. No-op
// on routes without an :accountId param.
accountsRouter.use('/*', accountSessionGate());

// Mount IAM routes (groups/policies/roles/super-admin/effective). Sub-router
// declares its own paths under /:accountId/iam/*, so mounting at '/' here is
// correct.
accountsRouter.route('/', iamRouter);
accountsRouter.route('/', auditRouter);

// ─── Static (non-parameterized) routes MUST come before /:accountId ────────
// Hono matches routes in registration order, so anything declared after the
// `:accountId` handler would be shadowed by it. The calls below mirror the
// original route-registration order exactly:
//   me, tokens GET/POST/DELETE        → registerTokenRoutes
//   accounts list/create/get/patch    → registerAccountRoutes
//   members + invites + leave         → registerMemberRoutes
registerTokenRoutes();
registerAccountRoutes();
registerMemberRoutes();

export { accountsRouter };
