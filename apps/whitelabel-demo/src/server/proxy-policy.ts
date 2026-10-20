/**
 * What a Lumen member may do through the proxy with their project-scoped
 * Kortix token. The token carries its minter's role on the project (owner)
 * and the minter's identity (the Lumen operator's Kortix user), so the proxy
 * narrows it to the calls the session UI makes: each allowed route is named,
 * by method. Everything else is refused. Project configuration (agents,
 * secrets, members, triggers, connectors, tokens, deletion), public links and
 * the sandbox's process, terminal, git and environment routes belong to
 * Lumen's operator. The operator's Kortix identity (accounts, members, access
 * lists) is not the member's to read.
 *
 * ponytail: a route allowlist here; Kortix narrowing a token's permissions
 * (contract proposal G2) would make it unnecessary.
 */

const PROJECT = '[^/]+';
// A session id is a UUID. A literal segment such as `warm` is a different route.
const SESSION = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SEG = '[^/]+';

/** A new session: the proxy tags it and records it as a Lumen thread. */
export const SESSION_CREATE = new RegExp(`^projects/${PROJECT}/sessions$`);

/**
 * One session. PATCH renames it, relabels it or merges metadata: the proxy
 * keeps Lumen's tags on it. DELETE goes through the thread record: only the
 * thread's creator or an org owner/admin may delete it.
 */
export const SESSION_ONE = new RegExp(`^projects/(${PROJECT})/sessions/(${SESSION})$`);

type Rule = readonly [methods: string, path: RegExp];
const rule = (methods: string, path: string): Rule => [methods, new RegExp(`^${path}$`)];

const S = `projects/${PROJECT}/sessions/${SESSION}`;
/** The session runtime: the daemon on port 8000 of the session's sandbox. */
const RT = `p/${SEG}/8000`;

const RULES: readonly Rule[] = [
  rule('GET', `projects/${PROJECT}(?:/(?:detail|sessions|change-requests|model-picker|connections|secrets|agents))?`),
  rule('POST', `projects/${PROJECT}/sessions`),
  // One session: every read except its public links and provider credential pools.
  rule('GET', `${S}(?:/(?!public-shares|provider-secret-pools)[^/].*)?`),
  rule('PATCH DELETE', S),
  rule('POST', `${S}/(?:start|stop|restart|recover|reload|reload-stream|prompts|prompts/hold|prompts/${SEG}/retry|attachments|question)`),
  rule('PATCH DELETE', `${S}/prompts/${SEG}`),
  rule('PUT', `${S}/(?:model|presence|watch|pin|archive)`),
  rule('GET POST', `projects/${PROJECT}/(?:attachments|approvals)(?:/.*)?`),
  rule('GET POST', `projects/${PROJECT}/(?:turn-permission|turn-question|turn-stream)`),
  // How this deployment addresses previews.
  rule('GET', 'p/config'),
  // Runtime reads: the transcript, events, status, the agent and command lists, workspace files.
  rule('GET', `${RT}/kortix/(?:runtime(?:/.*)?|health)`),
  rule('GET', `${RT}/(?:global/health|global/event|event|session|session/status|permission|question|provider|agent|skill|command|path|project/current|vcs/diff|lsp/diagnostics)`),
  rule('GET', `${RT}/session/${SEG}(?:/(?:message|message/${SEG}|diff|todo|children))?`),
  rule('GET', `${RT}/(?:file|file/content|file/status|find|find/file|find/symbol)`),
  // Runtime writes: a turn, its abort and steer, permission and question replies.
  rule('POST', `${RT}/kortix/runtime/.+`),
  rule('DELETE', `${RT}/kortix/runtime/messages/${SEG}/${SEG}`),
  rule('POST', `${RT}/kortix/abort(?:/after-tool)?`),
  rule('POST', `${RT}/session/${SEG}/(?:message|prompt_async|abort|revert|unrevert|summarize)`),
  rule('POST', `${RT}/(?:permission|question)/${SEG}/(?:reply|reject)`),
];

const RUNTIME_FILE = new RegExp(`^${RT}/(?:file|find)(?:/|$)`);

/** A runtime file read stays inside the workspace: a relative path, or one under /workspace. */
function workspacePath(query: URLSearchParams | undefined): boolean {
  for (const key of ['path', 'directory', 'dirs']) {
    for (const value of query?.getAll(key) ?? []) {
      if (value.split('/').includes('..')) return false;
      if (value.startsWith('/') && value !== '/workspace' && !value.startsWith('/workspace/')) return false;
      if (value.startsWith('~')) return false;
    }
  }
  return true;
}

/** Null when allowed, else the reason for a 403. */
export function blockedReason(method: string, path: string, query?: URLSearchParams): string | null {
  const m = method === 'HEAD' ? 'GET' : method;
  const allowed = RULES.some(([methods, re]) => methods.split(' ').includes(m) && re.test(path));
  if (allowed && RUNTIME_FILE.test(path) && !workspacePath(query)) return 'Only workspace files are available';
  if (allowed) return null;
  return m === 'GET' ? 'Not available in Lumen' : 'This workspace setting is managed by the Lumen operator';
}

const PERMISSION_PROBE = /^accounts\/[^/]+\/iam\/members\/[^/]+\/effective(:batch)?$/;
const DENIED = 'Managed by the Lumen operator';

interface Probe {
  action?: unknown;
  resourceType?: unknown;
  resourceId?: unknown;
}

function probeResult(p: Probe) {
  return {
    action: typeof p.action === 'string' ? p.action : '',
    resource_type: typeof p.resourceType === 'string' ? p.resourceType : 'account',
    resource_id: typeof p.resourceId === 'string' ? p.resourceId : null,
    allowed: false,
    reason: DENIED,
  };
}

/**
 * Account-level reads the session UI makes, answered by Lumen instead of
 * Kortix, or null to apply `blockedReason`. Kortix would answer them with
 * the operator's identity (`accounts/me`) or the operator's permissions
 * (`…/effective`), neither of which is the member's.
 *
 * - `GET accounts/me`: the Lumen user id, no email, no accounts.
 * - `…/effective` and `…/effective:batch`: every configuration action is
 *   denied, which is what a Lumen member may do. The UI hides those controls.
 */
export function localAnswer(
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  member: { userId: string },
): Response | null {
  if (method === 'GET' && path === 'accounts/me') {
    return Response.json({ user_id: member.userId, email: '', accounts: [] });
  }
  const probe = PERMISSION_PROBE.exec(path);
  if (!probe) return null;
  if (method === 'GET' && !probe[1]) {
    return Response.json(
      probeResult({ action: query.get('action'), resourceType: query.get('resourceType'), resourceId: query.get('resourceId') }),
    );
  }
  if (method === 'POST' && probe[1]) {
    const probes = (body as { probes?: unknown } | null)?.probes;
    return Response.json({ results: Array.isArray(probes) ? probes.slice(0, 200).map((p) => probeResult(p as Probe)) : [] });
  }
  return null;
}
