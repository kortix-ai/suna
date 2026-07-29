/**
 * The API call behind every KaaB action this app performs.
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
 *    token — the authorization header is always the `$KORTIX_API_KEY`
 *    placeholder and a secret's value is always `SECRET_VALUE_PLACEHOLDER`.
 *    That is why `SnippetContext` accepts a secret's IDENTIFIER and env KEY and
 *    has nowhere to put a value: a demo that teaches people to paste their key
 *    into a screenshot is worse than no demo.
 * 2. THE HTTP FORM SAYS WHO SENDS WHAT. `end_user_ref` is stamped by the proxy
 *    from the signed-in session (`src/server/end-user.ts`) and the browser can
 *    neither set nor change it — so every snippet that carries one names it in
 *    `serverInjected`. A snippet implying the browser sets it would teach
 *    exactly the vulnerability the design prevents.
 *
 * The building is pure and lives here rather than in the panel so what the demo
 * claims it sends can be asserted without rendering anything.
 */

import { NO_OVERRIDES, buildSessionCreateInput, type SessionOverrides } from './session-overrides';

/** Rendered wherever a real secret value would otherwise go. */
export const SECRET_VALUE_PLACEHOLDER = '$SECRET_VALUE';

/** The wrapper's bearer, as a placeholder — never the real key. */
export const AUTHORIZATION_HEADER = 'Authorization: Bearer $KORTIX_API_KEY';

/** Stand-ins for ids a screen may not have yet (the create dialog runs before
 *  any session exists). */
const PLACEHOLDER = {
  projectId: '{projectId}',
  sessionId: '{sessionId}',
  endUserRef: '{end_user_ref}',
  executionId: '{executionId}',
  identifier: '{identifier}',
  envKey: '{ENV_KEY}',
  model: 'anthropic/claude-sonnet-4-5',
  projectName: 'Acme workspace',
  idempotencyKey: 'lumen-probe-{uuid}',
} as const;

/**
 * Every KaaB action this app performs, in the order a wrapper author meets
 * them: provision a project, see what may be bound to a session, start one,
 * talk to it, read what it cost, end it, and manage the secrets behind it.
 *
 * An action the app performs with no id here is an action whose call the demo
 * hides — `tests/e2e/call-snippets-coverage.test.ts` reads the app's own source
 * to make that a test failure rather than an omission nobody notices.
 */
export const CALL_SNIPPET_IDS = [
  'project.provision',
  'connections.list',
  'session.create',
  'session.idempotentCreate',
  'session.prompt',
  'session.model',
  'session.rescope',
  'sessions.list',
  'session.delete',
  'usage.byEndUser',
  'usage.forEndUser',
  'usage.projectSessions',
  'approval.resolve',
  'secret.upsert',
  'secret.delete',
] as const;

export type CallSnippetId = (typeof CALL_SNIPPET_IDS)[number];

export interface SnippetContext {
  projectId?: string;
  sessionId?: string;
  /** The signed-in end-user. Shown so the HTTP form is complete — it is still
   *  the SERVER that puts it on the request. */
  endUserRef?: string;
  /** Alias -> human label for the chosen connections. The dialog passes these to
   *  `buildSessionCreateInput`, so a snippet built without them prints
   *  `{"slack": "prof_9"}` where the app actually sends
   *  `{"slack": "Acme Team Slack"}` — drift on the exact override this panel is
   *  meant to teach. */
  connectionLabels?: Record<string, string>;
  /** The create-only overrides currently chosen, so the create snippet shows
   *  what THIS dialog would send rather than a generic example. */
  overrides?: SessionOverrides;
  /** The agent a prompt would name, when one is picked. */
  agent?: string | null;
  /** The model a mid-session change would move to. */
  model?: string | null;
  executionId?: string;
  /** The project name a provision would send, when the field is filled in. */
  projectName?: string;
  /**
   * The `Idempotency-Key` a retry-safe create rides under. Server-minted, like
   * `end_user_ref` — a browser that could choose it could aim a replay at
   * another end-user's session, so this is only ever a key the SERVER made.
   */
  idempotencyKey?: string | null;
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
export type HttpForm =
  | {
      kind: 'rest';
      method: string;
      path: string;
      /** Request headers beyond authorization — `Idempotency-Key` is the one
       *  call whose whole behaviour lives in a header rather than a body. */
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
  /**
   * Fields or query params the proxy adds server-side. The browser sends none
   * of these, and one that names somebody else is refused rather than corrected.
   */
  serverInjected: string[];
  /** The things the two forms above would otherwise imply wrongly. */
  notes: string[];
  /**
   * True when the SDK block is the SERVER route's own code rather than the
   * browser's call.
   *
   * The distinction is load-bearing: a browser block must never contain
   * `end_user_ref` (the proxy refuses a client that names one, 403), while a
   * server block MUST stamp it — that is what makes the whole scheme work.
   * Without this flag a blanket "no end_user_ref in the SDK block" rule deleted
   * the field from a server-route example, teaching the exact forgery the rule
   * exists to prevent.
   */
  serverSideBlock?: boolean;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** `GET /usage?...` and friends, with the end-user ref escaped like the SDK does. */
function query(params: Record<string, string>): string {
  const search = new URLSearchParams(params).toString();
  return search ? `?${search}` : '';
}

/**
 * One copy-pasteable request block.
 *
 * The authorization line is part of the block on purpose: the single most
 * common wrapper mistake is forwarding the end user's own token upstream, and
 * seeing `$KORTIX_API_KEY` on every call is the correction.
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

function projectProvision(ctx: SnippetContext): CallSnippet {
  const name = ctx.projectName?.trim() || PLACEHOLDER.projectName;
  const body = { name, seed_starter: true };

  return {
    id: 'project.provision',
    title: 'Provision a project',
    summary: 'The one create path a wrapper can attribute to the end user who asked for it.',
    sdk: [
      `await kortix.projects.provision(${json(body)});`,
      '',
      '// The other half of the same rule: the list comes back filtered to the',
      '// projects THIS end user provisioned, so the two calls are one feature.',
      'await kortix.projects.list();',
    ].join('\n'),
    http: {
      kind: 'rest',
      method: 'POST',
      path: '/v1/projects/provision',
      body,
    },
    serverInjected: [],
    notes: [
      'Plain `POST /v1/projects` is refused 403 in wrapper mode (`src/server/policy.ts`). Provision is the path the proxy can hang ownership off: it records the returned project id against the signed-in end user, and every later `projects/{id}/…` call is checked against that record.',
      '`GET /v1/projects` is filtered on the way back to the projects that end user provisioned. The wrapper\'s key can see the whole account, so without that filter one signed-in user would read every other one\'s projects.',
      '`seed_starter: true` seeds a managed git repo server-side, so the project boots with no GitHub account and no repo name to choose. It provisions real infrastructure and can take a while — the SDK allows it 120s.',
    ],
  };
}

function connectionsList(ctx: SnippetContext): CallSnippet {
  return {
    id: 'connections.list',
    title: 'List the connections a session may bind',
    summary: 'What the picker is made of — and why some connectors have nothing to pick.',
    sdk: 'await kortix.project(projectId).connectors.profiles.list();',
    http: {
      kind: 'rest',
      method: 'GET',
      path: `/v1/projects/${ctx.projectId ?? PLACEHOLDER.projectId}/connector-profiles`,
    },
    serverInjected: [],
    notes: [
      'Runs SERVER-side (`src/app/api/connections/route.ts`), and the browser never gets the raw reply: `selectBindableConnections` narrows it first, so the picker cannot offer an option that would fail at create.',
      'Only TEAM connections (`owner_type: "project"`, `status: "active"`) survive that filter. A wrapper acts under one credential for many end users and has no personal upstream identity, so a connection a member authorized for themselves is not its to spend — and a revoked one binds fine and then fails at the first tool call.',
      'An alias with nothing bindable is still returned, carrying its reason, so the picker can say "a teammate has to share this one" instead of pretending the connector does not exist. There is deliberately no "connect it yourself" button: the interactive flow that would is refused 403 REQUIRE_CONNECTORS_INTERACTIVE_ONLY for a wrapper credential.',
      'The chosen `profile_id` is spent at CREATE, in `connector_bindings` — no route rebinds a running session.',
    ],
  };
}

function sessionCreate(ctx: SnippetContext): CallSnippet {
  const sessionId = ctx.sessionId ?? PLACEHOLDER.sessionId;
  // Built by the SAME function the dialog submits with, so the snippet cannot
  // drift from the request: an override the builder omits is omitted here too.
  const body = buildSessionCreateInput(ctx.overrides ?? NO_OVERRIDES, {
    sessionId,
    connectionLabels: ctx.connectionLabels,
  });
  // The app never types a session id — `generateSessionId()` produces it — so
  // the SDK form shows the variable and the HTTP form shows the value.
  const sdkBody = json(body).replace(`"${sessionId}"`, 'sessionId');

  return {
    id: 'session.create',
    title: 'Start a session with overrides',
    summary: 'Everything a session is scoped to is chosen here, once. There is no update path.',
    sdk: [
      "import { generateSessionId } from '@kortix/sdk';",
      '',
      'const sessionId = generateSessionId();',
      `await kortix.project(projectId).sessions.create(${sdkBody});`,
    ].join('\n'),
    http: {
      kind: 'rest',
      method: 'POST',
      path: `/v1/projects/${ctx.projectId ?? PLACEHOLDER.projectId}/sessions`,
      body: { ...body, end_user_ref: ctx.endUserRef ?? PLACEHOLDER.endUserRef },
    },
    serverInjected: ['end_user_ref'],
    notes: [
      'The browser never sends `end_user_ref`. The proxy adds it from the signed-in session (`src/server/end-user.ts`), and a request that names a different one is refused 403 rather than quietly corrected — a client that could choose it could bill another user or replay their session.',
      '`agent_name`, `secrets` and `connector_bindings` are CREATE-ONLY: no route updates them afterwards, which is why they are picked before the session exists.',
      '`secrets` lists secret IDENTIFIERS, not env KEYs. Two identifiers may share one KEY, and naming both in one create is refused 409 SECRET_IDENTIFIER_KEY_COLLISION.',
      '`inherit_unbound: true` accompanies any binding so the aliases nobody chose keep their project default instead of being switched off.',
      'The create body also accepts the session model, under a field named after the session runtime — the same field `changeModel()` writes on a running session.',
    ],
  };
}

function sessionIdempotentCreate(ctx: SnippetContext): CallSnippet {
  const key = ctx.idempotencyKey ?? PLACEHOLDER.idempotencyKey;
  // The probe's own body (`src/app/api/usage/route.ts`): `runtime_context` is
  // the smallest field that can differ between two creates without a secret or
  // a connector having to exist, which is what makes the conflict half of this
  // demonstrable on any project.
  const body = {
    end_user_ref: ctx.endUserRef ?? PLACEHOLDER.endUserRef,
    runtime_context: { lumen_probe: 'first' },
  };

  return {
    id: 'session.idempotentCreate',
    serverSideBlock: true,
    title: 'Retry a create without double-charging',
    summary: 'One key on both attempts: the replay returns the first session instead of a second.',
    sdk: [
      '// No SDK method carries this header today, so the retry-safe create is',
      "// the server route's own request: `attemptCreate` sets the key and",
      "// `forwardKortixRequest` substitutes the wrapper's API key for",
      '// Authorization (src/app/api/usage/route.ts).',
      'const key = `lumen-probe-${randomUUID()}`;',
      '',
      '// SERVER-side code, so it DOES stamp end_user_ref — that is this layer\'s',
      '// job. Only the browser is forbidden from setting it.',
      "const body = { end_user_ref: endUserRef, runtime_context: { lumen_probe: 'first' } };",
      '',
      '// Same key, same body — the second call must NOT provision a sandbox.',
      'const first = await attemptCreate({ projectId, body, idempotencyKey: key });',
      'const replay = await attemptCreate({ projectId, body, idempotencyKey: key });',
      'const safe = replay.sessionId === first.sessionId;',
    ].join('\n'),
    http: {
      kind: 'rest',
      method: 'POST',
      path: `/v1/projects/${ctx.projectId ?? PLACEHOLDER.projectId}/sessions`,
      headers: [`Idempotency-Key: ${key}`],
      body,
    },
    serverInjected: ['end_user_ref', 'Idempotency-Key'],
    notes: [
      'The key is minted SERVER-side and reused across both attempts. A browser that could choose it could aim a replay at another end-user’s session — which is why the same route stamps `end_user_ref` from the verified session, and why a replay carrying a different one is refused 409 IDEMPOTENCY_ORIGIN_CONFLICT.',
      'Same key + the SAME body returns the FIRST session id. A create buys real compute, so a blind retry after a timeout is otherwise a second sandbox and a second charge on the same end-user’s bill.',
      'Same key + a DIFFERENT body is refused 409 rather than handed the first session, because that session was built from other inputs: `runtime_context` gives IDEMPOTENCY_CONTEXT_CONFLICT, `secrets` IDEMPOTENCY_SECRETS_CONFLICT, `connector_bindings` IDEMPOTENCY_BINDING_CONFLICT.',
      'So a key belongs to one create ATTEMPT — mint it fresh, reuse it only while retrying that attempt. One key per user or per channel conflicts with itself the moment the overrides change.',
    ],
  };
}

function sessionPrompt(ctx: SnippetContext): CallSnippet {
  const agent = ctx.agent ?? null;
  return {
    id: 'session.prompt',
    title: 'Send a prompt (and switch agent per message)',
    summary: 'Each message names the agent that runs it — the one override that moves mid-session.',
    sdk: [
      'await kortix',
      '  .session(projectId, sessionId)',
      agent
        ? `  .send('Refund order 4182', { agent: '${agent}' });`
        : "  .send('Refund order 4182');",
      '',
      '// Or make the choice sticky for every following message:',
      `kortix.session(projectId, sessionId).setAgent(${agent ? `'${agent}'` : "'support'"});`,
    ].join('\n'),
    http: {
      kind: 'runtime',
      summary:
        'A prompt is not a REST call. It goes to the session runtime through the authenticated session proxy, and the SDK owns that URL — `ensureReady()` resolves the runtime, then sends the message. Client code is forbidden from building the path (scripts/sdk-boundary.mjs), so integrate through the SDK rather than reconstructing it.',
    },
    serverInjected: [],
    notes: [
      'The agent is per MESSAGE, not per session: `send(text, { agent })` overrides the sticky pick for that one turn.',
      'A switch to an agent with a DIFFERENT secrets grant is refused 409 AGENT_SWITCH_REQUIRES_NEW_SESSION. Retrying cannot work — the sandbox is already provisioned for the agent it booted with, and re-scoping now cannot un-read what that agent loaded. The remedy is a new session.',
    ],
  };
}

function sessionRescope(ctx: SnippetContext): CallSnippet {
  const projectId = ctx.projectId ?? PLACEHOLDER.projectId;
  const sessionId = ctx.sessionId ?? PLACEHOLDER.sessionId;
  return {
    id: 'session.rescope',
    title: 'Re-scope a running session',
    summary:
      'SET semantics: what you send REPLACES the current list, from the next prompt.',
    sdk: [
      '// Sending [b] after [a, b] means a stops being delivered.',
      'await kortix.session(projectId, sessionId).rescope({',
      "  secrets: ['TEST_KEY_2'],",
      "  connector_bindings: { gmail: { profile_id: 'prof_123' } },",
      '});',
    ].join('\n'),
    http: {
      kind: 'rest',
      method: 'PUT',
      path: `/v1/projects/${projectId}/sessions/${sessionId}/scope`,
      body: {
        secrets: ['TEST_KEY_2'],
        connector_bindings: { gmail: { profile_id: 'prof_123' } },
      },
    },
    // The wrapper chooses the new scope, so nothing here is server-injected —
    // unlike create, where the proxy stamps end_user_ref.
    serverInjected: [],
    notes: [
      'Dropping a secret stops it being DELIVERED from the next prompt. It cannot un-read a value the agent already has in its context or in a shell it already started — rotate it if that matters. The response says so with `retroactive: false`.',
      'Connector bindings resolve server-side on each tool call, so a binding change IS fully effective immediately.',
      'The agent’s manifest grant stays the ceiling: a session may narrow within it and restore anything inside it, never exceed it.',
    ],
  };
}

function sessionModel(ctx: SnippetContext): CallSnippet {
  const model = ctx.model ?? PLACEHOLDER.model;
  const projectId = ctx.projectId ?? PLACEHOLDER.projectId;
  const sessionId = ctx.sessionId ?? PLACEHOLDER.sessionId;

  return {
    id: 'session.model',
    title: 'Change the model mid-session',
    summary: 'The one create-time override that is still movable once a session is running.',
    sdk: [
      '// Server side (src/app/api/session-model/route.ts):',
      `await kortix.session(projectId, sessionId).changeModel('${model}');`,
      '',
      '// Browser side — this app goes through its own route, so the runtime-named',
      '// field stays server-side and client code says `model`:',
      `await fetch('/api/session-model?projectId=${projectId}&sessionId=${sessionId}', {`,
      "  method: 'PUT',",
      `  body: JSON.stringify({ model: '${model}' }),`,
      '});',
    ].join('\n'),
    http: {
      kind: 'rest',
      method: 'PUT',
      path: `/v1/projects/${projectId}/sessions/${sessionId}/model`,
      body: { '<runtime>_model': model },
    },
    serverInjected: [],
    notes: [
      'The upstream body field is named after the session runtime; `changeModel()` writes it for you. This app never spells it in client code (scripts/sdk-boundary.mjs keeps provider terminology out of the browser bundle) — the real field name is in `src/app/api/session-model/route.ts`.',
      'The reply carries `applied_live`. False means the model was stored and applies at the NEXT start; telling someone the model changed when their next answer comes from the old one is a lie worth avoiding.',
      'A live change restarts the runtime, which ends any in-flight turn.',
    ],
  };
}

function sessionsList(ctx: SnippetContext): CallSnippet {
  const endUserRef = ctx.endUserRef ?? PLACEHOLDER.endUserRef;
  return {
    id: 'sessions.list',
    title: "List one end-user's sessions",
    summary: 'The read that keeps two signed-in people apart when one API key makes every call.',
    sdk: 'await kortix.project(projectId).sessions.list();',
    http: {
      kind: 'rest',
      method: 'GET',
      path: `/v1/projects/${ctx.projectId ?? PLACEHOLDER.projectId}/sessions${query({
        end_user_ref: endUserRef,
      })}`,
    },
    serverInjected: ['end_user_ref'],
    notes: [
      'The browser asks for nothing: the proxy rewrites the query to the signed-in `end_user_ref` before it goes upstream. Without that, any signed-in user could read every other one\'s session list by adding the parameter themselves.',
      'A browser that names somebody else is refused 403 — the attempt surfaces rather than looking like it worked. The Isolation panel fires exactly that request so the refusal can be seen rather than trusted.',
      'A wrapper calling upstream directly with its own key DOES send this parameter — filtering happens server-side, so it never has to fetch a whole project to answer "show me this customer\'s sessions".',
    ],
  };
}

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
      'Both calls clear the SDK\'s cached runtime for these ids first (`forgetReady()`), so no later handle can resolve a sandbox that has been replaced or destroyed.',
      'Ownership is the only thing standing between one end user and another\'s session here: the upstream key could delete any session in the account, and the proxy is what checks this caller provisioned this project (`src/server/policy.ts`).',
      'Deleting is not a refund. Spend is metered into its own event log with the end-user ref copied onto every row, so `GET /v1/usage` still bills this session after the session row is gone — the rollup reads the meter, not the sessions that still exist.',
    ],
  };
}

function usageByEndUser(): CallSnippet {
  return {
    id: 'usage.byEndUser',
    title: 'Read usage split per end-user',
    summary: 'Upstream bills the account once; this is what splits that bill back out.',
    sdk: "await kortix.billing.usageRollup({ groupBy: 'end_user_ref' });",
    http: {
      kind: 'rest',
      method: 'GET',
      path: `/v1/usage${query({ group_by: 'end_user_ref' })}`,
    },
    serverInjected: [],
    notes: [
      'Account-wide, so this runs SERVER-side in `/api/usage` and is not reachable from the browser: `src/server/policy.ts` is deny-by-default and permits no `/usage` route to an end user.',
      'Spend with no `end_user_ref` (dashboard sessions, anything predating the field) has a NULL key and is excluded from the grouping — the rows do NOT add up to the account total, and the difference is the unattributed remainder.',
    ],
  };
}

function usageForEndUser(ctx: SnippetContext): CallSnippet {
  const endUserRef = ctx.endUserRef ?? PLACEHOLDER.endUserRef;
  return {
    id: 'usage.forEndUser',
    title: 'Read one end-user’s usage',
    summary: 'The query a wrapper runs to answer "what does this customer owe me".',
    sdk: `await kortix.billing.usageRollup({ endUserRef: '${endUserRef}' });`,
    http: {
      kind: 'rest',
      method: 'GET',
      path: `/v1/usage${query({ end_user_ref: endUserRef })}`,
    },
    serverInjected: ['end_user_ref'],
    notes: [
      'Narrowing applies to the TOTALS as well as the breakdown, so this is one end-user’s bill rather than the account’s total with one row highlighted.',
      'The ref is the signed-in identity, taken from the verified session server-side — the same value the proxy stamps on session creates, which is what makes the two numbers comparable.',
    ],
  };
}

function usageProjectSessions(ctx: SnippetContext): CallSnippet {
  return {
    id: 'usage.projectSessions',
    title: 'Read every session’s cost in a project',
    summary: 'The un-narrowed counterpart to the session list — every end-user’s sessions, priced.',
    sdk: 'await kortix.project(projectId).gateway.sessions();',
    http: {
      kind: 'rest',
      method: 'GET',
      path: `/v1/projects/${ctx.projectId ?? PLACEHOLDER.projectId}/gateway/sessions`,
    },
    serverInjected: [],
    notes: [
      'Not narrowed to anybody. `sessions.list` is the same project read with the proxy rewriting `end_user_ref` onto it, and this one has no such rewrite — which is why it runs SERVER-side in `/api/usage` and only the rows for projects the caller provisioned come back.',
      'Costs here are the ACCOUNT’s raw cost, per session. This app multiplies each row by `COST_MARKUP` before it reaches the browser, so the two numbers on screen are "what Kortix charged" and "what this wrapper would charge".',
      'These per-session rows and the per-end-user rollup are different reads of the same spend: this one groups by session, `GET /v1/usage?group_by=end_user_ref` groups by customer. Only the second one answers "who owes what".',
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
    sdk: `await kortix.project(projectId).approvals.resolve('${executionId}', 'approve', 'once');`,
    http: {
      kind: 'rest',
      method: 'POST',
      path: `/v1/projects/${projectId}/approvals/${executionId}`,
      body: { decision: 'approve', scope: 'once' },
    },
    serverInjected: [],
    notes: [
      'Three scopes, three different promises: `once` decides this call, `session` stops asking for THIS connector+action for the rest of the session, `session_all` stops asking for anything.',
      'The pending set is read from the per-SESSION audit, not the project-wide approval inbox: in wrapper mode one operator credential makes every call, so the inbox would hand this browser other end-users’ execution ids — and an execution id is all this route needs.',
      'Some refusals cannot be retried with the same credential at all; they need a decision from a signed-in person. A wrapper has no personal upstream identity, which is also why `require_connectors` is refused 403 REQUIRE_CONNECTORS_INTERACTIVE_ONLY.',
    ],
  };
}

function secretUpsert(ctx: SnippetContext): CallSnippet {
  const identifier = ctx.secret?.identifier ?? PLACEHOLDER.identifier;
  const name = ctx.secret?.name ?? PLACEHOLDER.envKey;
  const body = { identifier, name, value: SECRET_VALUE_PLACEHOLDER };

  return {
    id: 'secret.upsert',
    title: 'Create or rotate a secret',
    summary: 'One call does both — the identifier is what decides which.',
    sdk: `await kortix.project(projectId).secrets.upsert(${json(body)});`,
    http: {
      kind: 'rest',
      method: 'POST',
      path: `/v1/projects/${ctx.projectId ?? PLACEHOLDER.projectId}/secrets`,
      body,
    },
    serverInjected: [],
    notes: [
      `The value is never rendered here: \`${SECRET_VALUE_PLACEHOLDER}\` is a placeholder, and this builder has nowhere to put a real one. Read it from your own environment at the call site.`,
      'A new `identifier` creates; an existing one rotates in place, keeping its env KEY so every agent grant and session allowlist that names it keeps working.',
      'Pointing an existing identifier at a DIFFERENT env KEY is refused — the identifier is a stable handle, and re-aiming it would silently re-aim every grant that names it.',
      'Rotation reaches running sessions late: their agent already started with the old environment, and a live process cannot have its environment rewritten.',
    ],
  };
}

function secretDelete(ctx: SnippetContext): CallSnippet {
  const identifier = ctx.secret?.identifier ?? PLACEHOLDER.identifier;
  const name = ctx.secret?.name ?? PLACEHOLDER.envKey;

  return {
    id: 'secret.delete',
    title: 'Delete a secret',
    summary: 'Removes the identifier, not the grants that name it.',
    sdk: `await kortix.project(projectId).secrets.remove('${identifier}');`,
    http: {
      kind: 'rest',
      method: 'DELETE',
      path: `/v1/projects/${ctx.projectId ?? PLACEHOLDER.projectId}/secrets/${encodeURIComponent(
        identifier,
      )}`,
    },
    serverInjected: [],
    notes: [
      `Addressed by IDENTIFIER — url-encoded, since an identifier is free text — not by the env KEY. Several identifiers may store the same KEY (\`${name}\` here), so deleting by KEY would be ambiguous about which row to remove.`,
      'The value is gone and cannot be recovered. Nothing in this call renders it: the delete path needs the handle only, which is why deleting is the one secret operation with no value anywhere near it.',
      'Nothing that NAMES this identifier is rewritten by the delete. A later session create whose `secrets` allowlist still names it is refused 404 SECRET_IDENTIFIER_NOT_FOUND, so the identifier has to come out of the lists that name it too.',
      'Sessions already running keep what they booted with: their agent was started with the old environment and a live process cannot have its environment rewritten — the same reason a rotation reaches them late.',
    ],
  };
}

const BUILDERS: Record<CallSnippetId, (ctx: SnippetContext) => CallSnippet> = {
  'project.provision': projectProvision,
  'connections.list': connectionsList,
  'session.create': sessionCreate,
  'session.idempotentCreate': sessionIdempotentCreate,
  'session.prompt': sessionPrompt,
  'session.model': sessionModel,
  'session.rescope': sessionRescope,
  'sessions.list': sessionsList,
  'session.delete': sessionDelete,
  'usage.byEndUser': usageByEndUser,
  'usage.forEndUser': usageForEndUser,
  'usage.projectSessions': usageProjectSessions,
  'approval.resolve': approvalResolve,
  'secret.upsert': secretUpsert,
  'secret.delete': secretDelete,
};

/** One action's snippet, filled in with whatever the screen actually knows. */
export function callSnippet(id: CallSnippetId, ctx: SnippetContext = {}): CallSnippet {
  return BUILDERS[id](ctx);
}

/** Every snippet, in the order a wrapper author meets them. */
export function callSnippets(ctx: SnippetContext = {}): CallSnippet[] {
  return CALL_SNIPPET_IDS.map((id) => callSnippet(id, ctx));
}
