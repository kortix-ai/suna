// Orchestrator for the accounts router. Wires middleware + sub-router mounts +
// route modules in the SAME order as the original single-file router. The router
// instance + shared schemas/helpers live in ./core/app (a leaf module); each
// ./core/<group> module exports a register*() function that attaches its routes
// to that instance. We call them here (after middleware + mounts) so the final
// registration order is byte-identical to the original file.
import { accountsRouter } from './core/app';
import { supabaseAuth } from '../middleware/auth';
import { accountRequestGates } from './request-gates';
import { iamRouter, registerIamRoutes } from './iam';
import { auditRouter } from './audit';
import { registerTokenRoutes } from './core/tokens';
import { registerWorkspaceKeyRoutes } from './core/workspace-keys';
import { registerDeviceRoutes } from './core/devices';
import { registerAccountRoutes } from './core/accounts';
import { registerMemberRoutes } from './core/members';
import { registerTopUpRequestRoutes } from './core/top-up-requests';
import { registerAutomationRoutes } from './core/automations';
import { registerBrandingRoutes } from './branding';
import { registerSecretResourceRoutes } from './secret-resources';
import { registerCaptureRoutes } from '../capture/account-routes';
import { registerCaptureEnrollmentRoutes } from '../capture/enrollment-routes';

accountsRouter.use('/*', supabaseAuth);
// Resolve the workspace in the path, then enforce its session policy (max
// lifetime / idle timeout / force-logout) and its SSO rule (request-gates.ts).
for (const gate of accountRequestGates()) accountsRouter.use('/*', gate);

// Mount IAM routes (groups/policies/roles/super-admin/effective). Sub-router
// declares its own paths under /:accountId/iam/*, so mounting at '/' here is
// correct.
registerIamRoutes();
accountsRouter.route('/', iamRouter);
accountsRouter.route('/', auditRouter);

// ─── Static (non-parameterized) routes MUST come before /:accountId ────────
// Hono matches routes in registration order, so anything declared after the
// `:accountId` handler would be shadowed by it. The calls below mirror the
// original route-registration order exactly:
//   me/devices GET/DELETE            → registerDeviceRoutes
//   me, tokens GET/POST/DELETE        → registerTokenRoutes
//   accounts list/create/get/patch    → registerAccountRoutes
//   members + invites + leave         → registerMemberRoutes
registerDeviceRoutes();
registerTokenRoutes();
// Workspace settings › API keys: one list, keys that act as you, an agent or a bot.
registerWorkspaceKeyRoutes();
registerAccountRoutes();
registerMemberRoutes();
// A member out of credits asks the owners: /:accountId/top-up-requests.
registerTopUpRequestRoutes();
registerAutomationRoutes();
// Organization branding (Enterprise): /:accountId/branding + /assets/:kind.
registerBrandingRoutes();
registerSecretResourceRoutes();
// Kortix Capture, account-scoped (the account is Capture's tenant).
registerCaptureRoutes();
// Kortix Capture IT rollout: enrollment tokens and the computers waiting on them.
registerCaptureEnrollmentRoutes();

export { accountsRouter };
