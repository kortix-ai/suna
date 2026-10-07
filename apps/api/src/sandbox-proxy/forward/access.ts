import { HTTPException } from 'hono/http-exception';
import { PROJECT_ACTIONS, authorize } from '../../iam';
import { actorForUser } from '../../iam/actor';
import { setContextField } from '../../lib/request-context';
import { canAccessPreviewSandbox, canAccessSandboxSession, takeSessionAccessRefusal } from '../../shared/preview-ownership';
import type { SandboxRecord } from '../backend';
import { DEFAULT_AGENT_SENTINEL, jsonProxyError } from '../pre-prompt-env-sync';
import { stripInBoxProxyPrefix } from '../runtime-request';
import { carriesSessionData, requiresSessionVisibility } from '../session-data-ports';

// Who may reach a sandbox through the proxy: the caller's access kind, the
// account/session ownership gates, the platform-only control paths that are
// refused outright, and the agent-switch authorization on a turn start.

export type PreviewProxyAccess =
  | {
      kind: 'principal';
      userId: string;
      /** The caller's own session when the credential is bound to one (a sandbox
       *  token). Kortix-as-a-Backend shares ONE userId across every end-user, so
       *  this is what separates them. Null means a non-session-bound principal.
       *  REQUIRED so a new entry point cannot silently omit it and fail open. */
      callerSessionId: string | null;
      /** The caller's AGENT/SANDBOX token binding — `callerKortixSessionId(c)`,
       *  never the raw `c.get('sessionId')`. Only the trigger-session manager
       *  override reads it (see connectors/share.ts). REQUIRED for the same
       *  reason as the two fields around it. */
      boundCredentialSessionId: string | null;
      /** True when the SANDBOX ITSELF authored this request (it holds a
       *  credential that produces a perfectly valid principal). Such a request
       *  may never extend the box's deadline — that is the self-renewal this
       *  design exists to delete. REQUIRED, same reasoning as callerSessionId:
       *  a new entry point must not be able to omit it and fail open. */
      sandboxAuthored: boolean;
      /** `userId` is a person starting turns directly through this proxy: a
       *  turn start binds the session token to them (`bindSessionTurnIdentity`).
       *  Set only by the direct client routes. Absent = keep the token's
       *  identity (server-side delivery binds in `continueSession`). */
      bindTurnIdentity?: boolean;
    }
  | { kind: 'public_share' };

export function principalUserId(access: PreviewProxyAccess): string {
  return access.kind === 'principal' ? access.userId : '';
}

/**
 * Bind the provider-facing sandbox identifier to its canonical Kortix scope.
 * The request audit middleware runs after the proxy handler returns and reads
 * this request-local context. Without this binding, `/v1/p/...` activity is
 * present only in the account log and disappears from project/session history.
 */
export function bindSandboxRequestContext(
  record: { accountId: string; projectId: string; sessionId: string },
  sandboxId: string,
): void {
  setContextField('accountId', record.accountId);
  setContextField('projectId', record.projectId);
  setContextField('sessionId', record.sessionId);
  setContextField('sandboxId', sandboxId);
}

/** Account-membership gate for a principal: throws 403 when the caller may not reach this box. */
export async function assertPreviewSandboxAccess(
  access: PreviewProxyAccess,
  sandboxId: string,
  userId: string,
  record: SandboxRecord,
): Promise<void> {
  if (
    access.kind === 'principal' &&
    !(await canAccessPreviewSandbox({
      previewSandboxId: sandboxId,
      userId,
      sandbox: { sandboxId: record.sandboxId, accountId: record.accountId, projectId: record.projectId },
    }))
  ) {
    throw new HTTPException(403, {
      message: `Not authorized to access this sandbox, userId: ${userId}, sandboxId: ${sandboxId}`,
    });
  }
}

/**
 * The session-visibility gate, then the two control paths no proxied caller may
 * reach. Throws 403 for a session the caller may not see; returns the refusal
 * response for a blocked control path; null when the request may continue.
 */
export async function refuseSessionOrControlAccess(input: {
  access: PreviewProxyAccess;
  record: SandboxRecord;
  sandboxId: string;
  userId: string;
  callerSessionId: string | null;
  boundCredentialSessionId: string | null;
  upstreamPort: number;
  remainingPath: string;
  queryString: string;
  origin: string;
}): Promise<Response | null> {
  const { access, record, sandboxId, userId, callerSessionId, boundCredentialSessionId, upstreamPort, remainingPath, queryString, origin } = input;
  // The daemon port serves the session's OpenCode conversation + owner-synced
  // secrets; gate it on SESSION visibility (mirrors loadVisibleSession on the
  // REST side), not just account membership — closes the window where a member
  // whose access was revoked/downgraded replays captured ids on the data path.
  if (
    access.kind === 'principal' &&
    requiresSessionVisibility(upstreamPort) &&
    !(await canAccessSandboxSession({
      sessionId: record.sessionId,
      projectId: record.projectId,
      accountId: record.accountId,
      userId,
      callerSessionId: callerSessionId ?? null,
      boundCredentialSessionId,
    }))
  ) {
    // Name the branch. See `takeSessionAccessRefusal`: six branches can refuse
    // here and the constant message named none of them, which is why 6,970
    // server-side delivery refusals in 48h were undiagnosable.
    const refusal = takeSessionAccessRefusal({
      sessionId: record.sessionId,
      userId,
      callerSessionId: callerSessionId ?? null,
      boundCredentialSessionId,
    });
    console.warn('[preview] session access refused', {
      userId,
      port: upstreamPort,
      ...(refusal ?? {
        sessionId: record.sessionId,
        projectId: record.projectId,
        detail: 'no recorded verdict (served from the visibility cache)',
      }),
    });
    throw new HTTPException(403, {
      message: 'Not authorized to access this session',
    });
  }
  // /kortix/env is a platform-only control endpoint that writes the sandbox's
  // live secret env. The API reaches it server-to-server (postEnvToDaemon),
  // never through this user-facing proxy — block it so an account member can't
  // inject arbitrary env into a sandbox by POSTing /v1/p/<id>/8000/kortix/env.
  if (carriesSessionData(upstreamPort) && /^\/kortix\/env(?:$|[/?#])/.test(remainingPath)) {
    return jsonProxyError({ error: 'not found' }, 404, origin);
  }
  // `/kortix/refresh?base=1` force-resets the session's branch onto the base tip
  // — `git checkout -B <branch> <sha>`, where the branch IS the session id — so
  // it discards every commit the session made and deletes the files they added.
  //
  // The path itself must stay open: the SDK's `restart` mode is a plain
  // `/kortix/refresh`, and users legitimately reach it. Only the destructive
  // flag is refused, and refused HERE because this is the layer that knows the
  // request came from a user at all. Its one legitimate caller is the
  // warm-session workspace refresh at session create, which calls the daemon
  // directly and never traverses this proxy.
  //
  // The daemon enforces this independently (it also demands the stripped
  // service-call header) — a destructive primitive should not depend on a remote
  // allowlist staying correct.
  if (isProxiedBaseReset(upstreamPort, remainingPath, queryString)) {
    console.warn(`[PREVIEW] Refused base=1 branch reset on ${sandboxId} from a proxied caller`);
    return jsonProxyError(
      {
        error: 'base reset is not available through the sandbox proxy',
        code: 'BASE_RESET_FORBIDDEN',
      },
      403,
      origin,
    );
  }
  return null;
}

/**
 * Is this a proxied attempt at the daemon's DESTRUCTIVE branch reset?
 *
 * `/kortix/refresh?base=1` runs `git checkout -B <branch> <sha>` in the box, and
 * the branch IS the session id — so it discards every commit the session made
 * and deletes the files they added. Its one legitimate caller is the
 * warm-session workspace refresh at session create, which calls the daemon
 * directly and never comes through here.
 *
 * The PATH stays open on purpose: a plain `/kortix/refresh` is the SDK's
 * `restart` mode and users legitimately reach it. Only the flag is refused.
 *
 * Pure + exported so the gate is unit-tested without provisioning a box — the
 * same reason `shouldAutoResumeStoppedSandbox` is.
 */
export function isProxiedBaseReset(
  upstreamPort: number,
  remainingPath: string,
  queryString: string,
): boolean {
  if (!carriesSessionData(upstreamPort)) return false;
  // Strip the in-box `/proxy/{port}` prefix, as the connector gate does — a
  // request that reaches the daemon that way is the same request.
  const path = stripInBoxProxyPrefix(remainingPath);
  if (!/^\/kortix\/refresh(?:$|[/?#])/.test(path)) return false;
  return new URLSearchParams(queryString).get('base') === '1';
}

/**
 * May this caller run the agent this prompt names? Response to refuse, or null.
 *
 * Hoisted out of the forward loop so it runs BEFORE the connector gate. The
 * connector gate reads the requested agent's manifest, and a caller who may not
 * run agent B must not learn which connectors B requires by naming it — the
 * refusal list carries connector ids, names and strategies.
 *
 * Running it here also fixes a defect it had where it sat: below
 * `claimPromptDelivery`, so a 403 burned the Idempotency-Key and the retry after
 * being granted access came back as a silent duplicate.
 */
export async function agentSwitchRefusal(
  record: { accountId: string; projectId: string; agentName?: string | null },
  requestedAgent: string | null,
  userId: string | undefined,
  sandboxId: string,
  origin?: string,
): Promise<Response | null> {
  const sessionAgent = record.agentName ?? DEFAULT_AGENT_SENTINEL;
  if (!isConcreteAgentSwitch(requestedAgent, sessionAgent)) return null;
  const switchedToAgent = requestedAgent as string;
  if (!userId) {
    // A switch is an authorization decision and there is no principal to decide
    // about — a share-token forward, say. Refuse rather than run another agent
    // on nobody's authority.
    return jsonProxyError(
      {
        error: `You don't have permission to run the agent '${switchedToAgent}'.`,
        code: 'AGENT_NOT_AUTHORIZED',
        requested_agent: switchedToAgent,
      },
      403,
      origin,
    );
  }

  // No Hono context here — this runs inside the proxy forward loop, whose only
  // identity is the resolved `userId`. The question is an OBJECT-grant one
  // ("is this agent scoped to you"), which no credential can widen, so the
  // role-only actor is the same authority this call already had.
  const verdict = await authorize(
    actorForUser(userId, record.accountId),
    PROJECT_ACTIONS.PROJECT_AGENT_READ,
    {
      type: 'project',
      id: record.projectId,
      resource: { type: 'agent', id: switchedToAgent },
    },
  );
  if (verdict.allowed) return null;
  console.warn(
    `[PREVIEW] Refused prompt on ${sandboxId}: caller may not run agent '${switchedToAgent}' (${verdict.reason})`,
  );
  return jsonProxyError(
    {
      error: `You don't have permission to run the agent '${switchedToAgent}'.`,
      code: 'AGENT_NOT_AUTHORIZED',
      requested_agent: switchedToAgent,
    },
    403,
    origin,
  );
}

// A concrete agent different from the session's own is a SWITCH: authorize it
// exactly like the legacy `default` path below. The legacy `default` sentinel
// is non-binding: clients can echo a resolved default before the session's
// agent has loaded, so that path still requires agent authorization.
function isConcreteAgentSwitch(requestedAgent: string | null, sessionAgent: string): boolean {
  if (!requestedAgent) return false;
  // Asking for the sentinel is asking for "this session's own agent" — never a
  // switch, and there is no concrete agent to authorize.
  if (requestedAgent === DEFAULT_AGENT_SENTINEL) return false;
  // NOTE: there is deliberately NO `sessionAgent === DEFAULT_AGENT_SENTINEL`
  // carve-out here. There used to be, and it was an authorization bypass
  // (CWE-863): the body's `agent` is only stripped when the REQUESTED agent is
  // the sentinel (see the `bodyWithoutPromptAgent` call site), so a
  // `default`-bound session naming a CONCRETE agent really did run that agent
  // and really did have the token re-minted to its connector/Kortix-CLI grant —
  // while skipping the `project.agent.read` check entirely. Anyone who could
  // use a default-bound session could therefore run any agent in the project.
  //
  // The carve-out was written for the old 409 refusal, where it was right: the
  // client resolves "the default" to a concrete name for display and echoes it
  // back, and refusing that ordinary echo 409'd every new session. It is wrong
  // for an authorization check. Authorizing the echo is correct and cheap — the
  // caller genuinely is asking to run that agent, and a member entitled to it
  // passes exactly as they do on the concrete-to-concrete path.
  return requestedAgent !== sessionAgent;
}
