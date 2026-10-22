import type { readRunningTurn, sessionLifecycleStandingFor, turnPrompterOf } from '../../projects/surface';
import type { PreviewProxyAccess } from './access';

/** `by`: the person the stop is recorded under, null for an agent credential. */
export type ClientAbortVerdict = { allowed: true; by: string | null } | { allowed: false };

export interface ClientAbortAuthorityDeps {
  readRunningTurn: typeof readRunningTurn;
  turnPrompterOf: typeof turnPrompterOf;
  standing: typeof sessionLifecycleStandingFor;
}

// Loaded on the first abort, never with the forwarder: the projects surface
// reaches the sandbox backend, which the proxy suites stub.
const authority = () => import('../../projects/surface');
const liveDeps: ClientAbortAuthorityDeps = {
  readRunningTurn: async (sessionId) => (await authority()).readRunningTurn(sessionId),
  turnPrompterOf: async (sessionId, messageId) => (await authority()).turnPrompterOf(sessionId, messageId),
  standing: async (input) => (await authority()).sessionLifecycleStandingFor(input),
};

/**
 * May a client abort through the proxy stop this session's running turn?
 *
 * The rule is `turn-stop-authority.ts`: the turn's prompter, the session owner
 * or a project manager. The reads go cheapest first: nothing running, then the
 * prompter, then the owner/manager standing. The caller skips sandbox-authored
 * requests before it asks: the box aborting its own turn is not a person.
 *
 * - A person (a principal not bound to an agent session): the rule above.
 * - An agent credential bound to a session that is NOT sandbox-authored: no
 *   entry point builds one today (a bound credential is sandbox-authored on
 *   both proxy edges). It keeps the access the session gate already gave it
 *   and is recorded under nobody. Narrowing it needs the REST side's agent
 *   standing, which the proxy does not load.
 * - A public share: no person and no standing, so refused. Shares cannot reach
 *   the daemon port, so this is the closed default, not a live path.
 */
export async function decideClientAbort(
  access: PreviewProxyAccess,
  record: { accountId: string; projectId: string; sessionId: string },
  deps: ClientAbortAuthorityDeps = liveDeps,
): Promise<ClientAbortVerdict> {
  if (access.kind !== 'principal') return { allowed: false };
  if (access.boundCredentialSessionId !== null) return { allowed: true, by: null };
  const by = access.userId;
  const running = await deps.readRunningTurn(record.sessionId);
  if (!running) return { allowed: true, by };
  if ((await deps.turnPrompterOf(record.sessionId, running.messageId)) === by) return { allowed: true, by };
  const manages = await deps.standing({
    userId: by,
    accountId: record.accountId,
    projectId: record.projectId,
    sessionId: record.sessionId,
  });
  return manages ? { allowed: true, by } : { allowed: false };
}
