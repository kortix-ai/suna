import { bindCatalog } from './facade-catalog';
import { bindCommerce } from './facade-commerce';
import { bindIdentity } from './facade-identity';
import { bindPreviewOptions } from './facade-preview';
import { session } from './session-handle';
export { SessionNotReadyError } from './session-shared';
export type { SessionModel } from './session-shared';
import type { RuntimeClient } from '../runtime/client';
import { bindProjectAccessResources } from './project-access-resources';
import { bindProjectAccessSecurity } from './project-access-security';
import { projectConnections } from './project-connections';
import { connectorDataPlane, connectorHandle } from './project-connectors';
import { bindProjectCore } from './project-core';
import { bindProjectOperations } from './project-operations';
import { bindProjectPlatformResources } from './project-platform-resources';
import { bindProjectPlatformSecurity } from './project-platform-security';
/**
 * createKortix — the single opinionated entry point to the Kortix data layer.
 *
 * One client. Every action a method. The host app imports ONLY from `@kortix/sdk`
 * — never `@opencode-ai/sdk`, never `backendApi`/`authenticatedFetch` directly.
 *
 *   const kortix = createKortix({ getToken });
 *   await kortix.projects.list();
 *   await kortix.project(pid).secrets.upsert({ name, value });
 *   const s = kortix.session(pid, sid);
 *   await s.start();
 *   await s.send('what files are here?');                  // through the prompt inbox
 *   const { messages } = await s.messages();               // { info, parts }, kortix.transcript.v1
 *
 * REST methods are direct references to the platform client, so they keep their
 * exact types with zero re-typing. The `project()`/`session()` handles bind ids
 * for ergonomics. Reactive data still comes from `@kortix/sdk/react` hooks.
 */

import { getClient } from '../runtime/client';

import { type KortixPlatformConfig, configureKortix } from '../http/config';
import * as P from '../rest/projects-client';

function runtime(): RuntimeClient {
  return getClient();
}

// The config the last GLOBAL client wrote. A second global client with another
// backend or token source re-points every earlier client, so it is a bug in a
// multi-tenant process. One warning per process, never an error: a host that
// re-creates its one client (HMR, a re-login) is legitimate.
let lastGlobalConfig: KortixPlatformConfig | null = null;
let warnedGlobalRepoint = false;

function noteGlobalClient(config: KortixPlatformConfig): void {
  const previous = lastGlobalConfig;
  lastGlobalConfig = config;
  if (warnedGlobalRepoint || !previous) return;
  if (previous.backendUrl === config.backendUrl && previous.getToken === config.getToken) return;
  warnedGlobalRepoint = true;
  console.warn(
    '[kortix] createKortix() was called again with a different backendUrl or getToken. ' +
      'Every client shares one process-global config, so the earlier client now uses the new one. ' +
      'For several tenants in one process use createScopedKortix() from @kortix/sdk/server.',
  );
}

export function createKortix(config: KortixPlatformConfig, opts?: { global?: boolean }) {
  // Wire the platform seam once. All wrapped functions read it.
  //
  // `opts.global === false` (used by `@kortix/sdk/server`'s `createScopedKortix`)
  // skips the process-wide write entirely — that caller relies solely on the
  // `AsyncLocalStorage` scope `createScopedKortix` wraps every method call in,
  // so this returned facade never touches (or is affected by) the module-global
  // singleton other concurrent `createKortix()` calls in the same process share.
  if (opts?.global !== false) noteGlobalClient(config);
  configureKortix(config, opts);

  const resolvePreviewOptsForSandbox = bindPreviewOptions(config);

  const { auth, accounts, iam, accountInvites } = bindIdentity();
  const { billing, sandboxShares } = bindCommerce();
  const { projects, github, gitBackend, connectStatus, marketplace } = bindCatalog();

  /** Id-bound handle for a single project: every sub-resource, projectId pre-applied. */
  function project(projectId: string) {
    const connections = projectConnections(projectId);
    return {
      ...bindProjectCore(projectId),
      ...bindProjectAccessResources(projectId),
      ...bindProjectAccessSecurity(projectId),
      ...bindProjectOperations(projectId, connections),
      ...bindProjectPlatformResources(projectId),
      ...bindProjectPlatformSecurity(projectId),
      /** One connector of this project: `run`, `call`, `describe`, `accounts`, `paginate`. */
      connector: <S extends string>(slug: S) => connectorHandle(projectId, slug),
      session: (sessionId: string) =>
        session(projectId, sessionId, config, resolvePreviewOptsForSandbox),
    };
  }

  return {
    /** The platform config in effect (for diagnostics). */
    config,
    /** Headless regular auth — see `auth` above. */
    auth,
    accounts,
    /** Identity and access — assignments, roles, permissions, groups, probes. */
    iam,
    /** Account-invite lifecycle reached by invite token alone (accept/decline/describe). */
    accountInvites,
    projects,
    /** Connector calls scoped by an agent/session token when no project id is available. */
    connectors: connectorDataPlane(),
    /** One connector in the token's scope (a project-scoped token or a session token). */
    connector: <S extends string>(slug: S) => connectorHandle(undefined, slug),
    project,
    session: (projectId: string, sessionId: string) =>
      session(projectId, sessionId, config, resolvePreviewOptsForSandbox),
    /** GitHub App installation + repository linking (account-scoped). */
    github,
    /** The instance git backend ("Kortix managed", deployment-scoped). */
    gitBackend,
    /** Billing read surface, including unified session costs. */
    billing,
    /** Public share links for a sandbox port (`/v1/p/share`, sandbox-scoped). */
    sandboxShares,
    /** Deployment-wide Pipedream/easy-connect availability flag (not project-scoped). */
    connectStatus,
    /** Public marketplace catalog browse + sources (`/v1/marketplace/*`, not project-scoped). */
    marketplace,
    /** Push device registration for a native app (`/v1/notifications/device-token`). */
    notifications: {
      registerDeviceToken: P.registerDeviceToken,
      unregisterDeviceToken: P.unregisterDeviceToken,
    },
    /** The pasted-API-key UX check — `GET /accounts/me`, never throws. */
    validateToken: P.validateToken,
    /** Escape hatch: the typed opencode client for the active sandbox. */
    runtime,
  };
}

export type Kortix = ReturnType<typeof createKortix>;
/** The id-bound project handle returned by `kortix.project(id)`. */
export type ProjectHandle = ReturnType<Kortix['project']>;
/** The id-bound session handle returned by `kortix.session(pid, sid)`. */
export type SessionHandle = ReturnType<Kortix['session']>;
