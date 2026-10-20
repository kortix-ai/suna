/**
 * The API call behind every Kortix action this app performs (the developer
 * panel, `src/components/dev/call-snippet.tsx`; off unless NEXT_PUBLIC_LUMEN_DEV_PANELS=1).
 *
 * A reference wrapper's real job is to teach what to call, and a screenshot of a
 * dialog teaches nothing. So each action carries the two forms a wrapper author
 * actually arrives with:
 *
 *  - SDK — the `@kortix/sdk` call this app runs, verbatim.
 *  - HTTP — the request that ends up on the wire, for anyone integrating from a
 *    language with no SDK.
 *
 * Two rules this module exists to keep:
 *
 * 1. NOTHING SECRET IS EVER RENDERED. No secret value, no API key, no bearer
 *    token — the authorization header is always the `$KORTIX_MEMBER_TOKEN`
 *    placeholder and a secret's value is always `SECRET_VALUE_PLACEHOLDER`.
 *    That is why `SnippetContext` accepts a secret's IDENTIFIER and env KEY and
 *    has nowhere to put a value: a demo that teaches people to paste their key
 *    into a screenshot is worse than no demo.
 * 2. THE HTTP FORM MATCHES THE SDK CALL. The wrapper adds authorization only.
 *    Product data remains in the request body or query shown by the snippet.
 *
 * The building is pure and lives here rather than in the panel so what the demo
 * claims it sends can be asserted without rendering anything.
 */


/** Rendered wherever a real secret value would otherwise go. */
export const SECRET_VALUE_PLACEHOLDER = '$SECRET_VALUE';

/**
 * The upstream bearer, as a placeholder: the member's project-scoped token
 * that the proxy swaps in. Never a real key.
 */
export const AUTHORIZATION_HEADER = 'Authorization: Bearer $KORTIX_MEMBER_TOKEN';

/** Stand-ins for ids a screen may not have yet (the create dialog runs before
 *  any session exists). */
const PLACEHOLDER = {
  projectId: '{projectId}',
  sessionId: '{sessionId}',
  executionId: '{executionId}',
  identifier: '{identifier}',
  envKey: '{ENV_KEY}',
  model: 'anthropic/claude-sonnet-4-5',
  projectName: 'Acme workspace',
} as const;

/**
 * Every Kortix action this app performs, in the order a wrapper author meets
 * them: provision a project, see what may be bound to a session, start one,
 * talk to it, read what it cost, end it, and manage the secrets behind it.
 *
 * An action the app performs with no id here is an action whose call the demo
 * hides — `tests/unit/call-snippets-coverage.test.ts` reads the app's own source
 * to make that a test failure rather than an omission nobody notices.
 */
export const CALL_SNIPPET_IDS = [
  'session.delete',
  'approval.resolve',
] as const;

export type CallSnippetId = (typeof CALL_SNIPPET_IDS)[number];

export interface SnippetContext {
  projectId?: string;
  sessionId?: string;
  /** The agent a prompt would name, when one is picked. */
  agent?: string | null;
  executionId?: string;
  /** The project name a provision would send, when the field is filled in. */
  projectName?: string;
  /**
   * A secret's addressable parts. There is deliberately NO `value` field: this
   * type is the boundary that keeps secret material out of every snippet.
   */
  secret?: { identifier?: string; name?: string };
}

/**
 * The HTTP form. `runtime` is not a REST call at all — a prompt goes to the
 * session's own runtime through the authenticated session proxy, whose URL the
 * SDK owns and client code is forbidden to build (`scripts/sdk-boundary.mjs`).
 * Printing a path there would teach hand-rolling the one thing the SDK exists
 * to hold.
 */
type HttpForm =
  | {
      kind: 'rest';
      method: string;
      path: string;
      /** Request headers beyond authorization. */
      headers?: string[];
      body?: unknown;
    }
  | { kind: 'runtime'; summary: string };

export interface CallSnippet {
  id: CallSnippetId;
  /** Names the action as the UI names it, not as the route names it. */
  title: string;
  /** One line: what this call is for. */
  summary: string;
  /** The `@kortix/sdk` call this app makes. */
  sdk: string;
  http: HttpForm;
  /** Fields or headers the application server adds. */
  serverInjected: string[];
  /** The things the two forms above would otherwise imply wrongly. */
  notes: string[];
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * One copy-pasteable request block.
 *
 * The authorization line is part of the block on purpose: the single most
 * common wrapper mistake is forwarding the end user's own token upstream, and
 * seeing `$KORTIX_MEMBER_TOKEN` on every call is the correction.
 */
export function renderHttp(form: HttpForm): string {
  if (form.kind === 'runtime') return form.summary;
  const lines = [`${form.method} ${form.path}`, AUTHORIZATION_HEADER, ...(form.headers ?? [])];
  if (form.body === undefined) return lines.join('\n');
  lines.push('Content-Type: application/json', '', json(form.body));
  return lines.join('\n');
}

/** True when the HTTP form is a request someone can copy and run. */
export function isCopyableHttp(form: HttpForm): boolean {
  return form.kind === 'rest';
}

// ── The calls ────────────────────────────────────────────────────────────────

function sessionDelete(ctx: SnippetContext): CallSnippet {
  const projectId = ctx.projectId ?? PLACEHOLDER.projectId;
  const sessionId = ctx.sessionId ?? PLACEHOLDER.sessionId;

  return {
    id: 'session.delete',
    title: 'Restart or delete a session',
    summary: 'The two ways a session ends — one keeps the sandbox, one destroys it.',
    sdk: [
      '// Reboots the runtime, keeps the session and its sandbox identity.',
      'await kortix.session(projectId, sessionId).restart();',
      '',
      '// Destroys the session and the sandbox behind it. Not recoverable.',
      'await kortix.session(projectId, sessionId).delete();',
    ].join('\n'),
    http: {
      kind: 'rest',
      method: 'DELETE',
      path: `/v1/projects/${projectId}/sessions/${sessionId}`,
    },
    serverInjected: [],
    notes: [
      `Restart is a separate call — \`POST /v1/projects/${projectId}/sessions/${sessionId}/restart\`. It keeps the sandbox, so a session that came up wrong recovers without losing its transcript, but it still ends whatever turn was in flight.`,
      "Both calls clear the SDK's cached runtime for these ids first (`forgetReady()`), so no later handle can resolve a sandbox that has been replaced or destroyed.",
      "The member token reaches only this workspace's project: Kortix refuses it on every other project, so one organization cannot end another's session.",
      'Deleting is not a refund. The session cost record remains available after the runtime is destroyed.',
    ],
  };
}
function approvalResolve(ctx: SnippetContext): CallSnippet {
  const projectId = ctx.projectId ?? PLACEHOLDER.projectId;
  const executionId = ctx.executionId ?? PLACEHOLDER.executionId;
  return {
    id: 'approval.resolve',
    title: 'Resolve an approval',
    summary: 'A `require_approval` gate ends the agent’s turn until a person decides.',
    sdk: `await kortix.project(projectId).approvals.resolve('${executionId}', 'approve');`,
    http: {
      kind: 'rest',
      method: 'POST',
      path: `/v1/projects/${projectId}/approvals/${executionId}`,
      body: { decision: 'approve' },
    },
    serverInjected: [],
    notes: [
      'A decision covers exactly the call that asked for it. The `session` / `session_all` scopes were removed: a grant keyed on (session, connector, action) ignores the ARGUMENTS, so approving a send to one recipient silently pre-authorised a send to any other. To run a tool unattended, author an `always_run` policy rule instead.',
      'The pending set is read from the per-SESSION audit, not the project-wide approval inbox: every member of the workspace shares one project, so the inbox would hand this browser execution ids from other members’ threads, and an execution id is all this route needs.',
      'Some refusals cannot be retried with the same credential at all; they need a decision from a signed-in person. A wrapper has no personal upstream identity, which is also why a connector call denied `connector_not_connected` for a member-owned account can never be resolved by this credential — only a teammate connecting their own account, or the project sharing one, fixes it.',
    ],
  };
}

// `connector.connect-link` (kortix.project().setupLinks.requestConnector())
// was removed with `ConnectRequiredCard`: the create-time connector pre-flight
// it minted a remedy link for can no longer occur (`require_connectors` is
// inert), so the button it backed had nothing left to be a remedy for. The
// call-time gate's remedy is `connect_url` on the `connector_not_connected`
// denial, surfaced by the transcript's `SetupLinkButton` — not a snippet here.

const BUILDERS: Record<CallSnippetId, (ctx: SnippetContext) => CallSnippet> = {
  'session.delete': sessionDelete,
  'approval.resolve': approvalResolve,
};

/** One action's snippet, filled in with whatever the screen actually knows. */
export function callSnippet(id: CallSnippetId, ctx: SnippetContext = {}): CallSnippet {
  return BUILDERS[id](ctx);
}

/** Every snippet, in the order a wrapper author meets them. */
export function callSnippets(ctx: SnippetContext = {}): CallSnippet[] {
  return CALL_SNIPPET_IDS.map((id) => callSnippet(id, ctx));
}
