/**
 * What a Lumen member may do through the proxy with their project-scoped
 * Kortix token. The token carries its minter's role on the project (owner)
 * and the minter's identity (the Lumen operator's Kortix user), so the proxy
 * narrows it to the calls the session UI makes: each allowed route is named,
 * by method. Everything else is refused. Project configuration (agents,
 * secrets, members, triggers, connectors, tokens, deletion), public links,
 * reminders, drives, the session log and config, and the sandbox's process,
 * terminal, git, file and environment routes belong to Lumen's operator. The
 * operator's Kortix identity (accounts, members, access lists, session
 * audit and participants) is not the member's to read.
 *
 * ponytail: a route allowlist here; Kortix narrowing a token's permissions
 * (contract proposal G2) would make it unnecessary.
 */

import { BRAND } from '@/config/brand';

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

// Each rule is a request the session UI makes, measured from the customer journey
// (sign up, a workspace per template, thread, streamed prompt, question, stop,
// edit and rewind, attachment, @-mention, every tab, rename, restart, delete,
// reload mid-stream). A route the UI never calls is refused.
const RULES: readonly Rule[] = [
  // The project: its card, agents and models (the picker and its defaults), connection and secret names, change requests.
  rule('GET', `projects/${PROJECT}(?:/(?:detail|change-requests|model-picker|model-defaults|connections|secrets))?`),
  // The Files and Changes tabs: the project repository, read only.
  rule('GET', `projects/${PROJECT}/(?:files|files/content|files/search|files/history|branches|commits|version-diff)`),
  // One commit and its patch: the Changes tab's commit dialog.
  rule('GET', `projects/${PROJECT}/commits/[0-9a-f]{7,40}(?:/diff)?`),
  rule('POST', `projects/${PROJECT}/sessions`),
  rule('POST', `projects/${PROJECT}/attachments(?:/${SEG}/complete)?`),
  // One session: the session, its live stream, transcript, turn, queue, authors, model usage, scope, previews.
  rule('GET', `${S}(?:/(?:events|snapshot|transcript|turn|prompts|message-authors|model-usage|scope|previews))?`),
  rule('PATCH DELETE', S),
  rule('POST', `${S}/(?:start|restart|prompts|prompts/hold)`),
  // A queued prompt's edit and removal (the composer's queue; not seen live: prompts steered).
  rule('PATCH DELETE', `${S}/prompts/${SEG}`),
  // How this deployment addresses previews.
  rule('GET', 'p/config'),
  // Runtime reads: health, status, the transcript, the command list, pending permissions and questions.
  rule('GET', `${RT}/(?:kortix/health|session|session/status|permission|question|provider|command|path|project/current|lsp/diagnostics)`),
  rule('GET', `${RT}/session/${SEG}(?:/(?:message|todo))?`),
  // Workspace files: the composer's @-mention search.
  rule('GET', `${RT}/(?:file|find/file)`),
  // Runtime writes: abort, edit-and-rewind, permission and question replies.
  rule('POST', `${RT}/session/${SEG}/(?:abort|revert)`),
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
// The session audit log and participant list name the operator's Kortix user.
const SESSION_AUDIT = new RegExp(`^projects/${PROJECT}/sessions/(${SESSION})/audit$`);
const SESSION_PARTICIPANTS = new RegExp(`^projects/${PROJECT}/sessions/${SESSION}/participants$`);
// A session's mounted folders. The firm Drive holds every matter, so a member sees none of it here.
const SESSION_DRIVES = new RegExp(`^projects/${PROJECT}/sessions/${SESSION}/drives$`);
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
 * Reads the session UI makes that Lumen answers instead of Kortix, or null
 * to apply `blockedReason`. Kortix would answer them with the operator's
 * identity (`accounts/me`, audit, participants) or the operator's
 * permissions (`…/effective`), neither of which is the member's.
 *
 * - `GET accounts/me`: the Lumen user id, no email, no accounts.
 * - `…/effective` and `…/effective:batch`: every configuration action is
 *   denied, which is what a Lumen member may do. The UI hides those controls.
 * - A session's `audit` and `participants`: empty. The UI polls both; Kortix
 *   would list the operator's user, the only identity behind member tokens.
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
  if (method === 'GET') {
    const audit = SESSION_AUDIT.exec(path);
    if (audit) {
      return Response.json({ session_id: audit[1], audit_access: false, count: 0, events: [], next_cursor: null, actions: [] });
    }
    if (SESSION_PARTICIPANTS.test(path)) return Response.json({ participants: [], total: 0, multi_user: false });
    if (SESSION_DRIVES.test(path)) return Response.json({ drives: [], personal: false, skipped: [], skippedMessage: null });
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

/**
 * The request headers Kortix gets from the browser: the ones the SDK and the
 * browser set that a session route reads (measured from `packages/sdk/src`:
 * `Content-Type`, `Accept`, `Last-Event-ID` on a stream resume,
 * `X-Kortix-Client-Version`; the browser's `If-None-Match` revalidation).
 * Cookies, user agent, referer, client hints, `Origin` and forwarded-for
 * headers stay in Lumen. The proxy sets `Authorization` itself.
 */
const FORWARDED_HEADERS = ['accept', 'content-type', 'last-event-id', 'if-none-match', 'x-kortix-client-version'];

export function forwardedHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

// Responses that name the session's Kortix owner: the session record (create,
// read, rename), the open-session snapshot, and the transcript's authors.
const SESSION_RECORD = new RegExp(`^projects/${PROJECT}/sessions(?:/${SESSION})?$`);
const SESSION_SNAPSHOT = new RegExp(`^${S}/snapshot$`);
const MESSAGE_AUTHORS = new RegExp(`^${S}/message-authors$`);

// Responses that carry git authors and commit messages: the Changes tab's
// branches and commits, one commit, and a file's history.
const GIT_HISTORY = new RegExp(`^projects/${PROJECT}/(?:branches|commits|commits/[0-9a-f]{7,40}|files/history)$`);

// The runtime's slash-command list: the platform's own skills (kortix-cli,
// kortix-apps, …) are not a customer's commands.
const RUNTIME_COMMANDS = new RegExp(`^${RT}/command$`);
const PLATFORM_COMMAND = /kortix|opencode/i;

// The project record and its detail: the feature catalog and the manifest
// describe the platform by name ("A Kortix project.", "the Kortix LLM gateway").
const PROJECT_RECORD = new RegExp(`^projects/${PROJECT}(?:/detail)?$`);

// The session's turn state: a failed turn carries Kortix's own error copy
// ("…did not reach Kortix", "…so Kortix closed it").
const SESSION_TURN = new RegExp(`^${S}/turn$`);

/** True when `redactIdentity` rewrites this path's JSON response. */
export function redactsIdentity(path: string): boolean {
  return (
    SESSION_RECORD.test(path) ||
    SESSION_SNAPSHOT.test(path) ||
    MESSAGE_AUTHORS.test(path) ||
    GIT_HISTORY.test(path) ||
    SESSION_TURN.test(path) ||
    RUNTIME_COMMANDS.test(path) ||
    PROJECT_RECORD.test(path)
  );
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function scrubSession(session: unknown): unknown {
  if (!isObject(session)) return session;
  const out: Json = { ...session, owner_email: null, owner_name: null, owner_avatar_url: null };
  if (isObject(session.initiator)) out.initiator = { ...session.initiator, label: null };
  return out;
}

const notMember = (a: unknown) => !(isObject(a) && a.kind === 'member');

const KORTIX_WORD = /\bKortix\b/g;

/**
 * A branch or commit, as Lumen shows it. Every commit in a workspace is made
 * by Lumen: the seed commit Kortix writes (author `Kortix`, `noreply@kortix.ai`,
 * "chore: scaffold Kortix project") and the agent's commits, made under the
 * operator's Kortix user. So every author and committer is the brand with no
 * email, and the word Kortix in a message becomes the brand.
 */
function scrubGit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubGit);
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'author_name' || key === 'committer_name') out[key] = BRAND.name;
    else if (key === 'author_email' || key === 'committer_email') out[key] = '';
    else if ((key === 'subject' || key === 'body') && typeof v === 'string') out[key] = v.replace(KORTIX_WORD, BRAND.name);
    else out[key] = scrubGit(v);
  }
  return out;
}

/** Every string in a value names the brand instead of Kortix. Keys and non-strings stay. */
function scrubWord(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(KORTIX_WORD, BRAND.name);
  if (Array.isArray(value)) return value.map(scrubWord);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubWord(v)]));
}

/**
 * The slash-command list: the platform's own commands go, and a kept
 * command's template (it becomes the prompt text when picked) names the brand.
 */
function scrubCommands(list: unknown[]): unknown[] {
  return list
    .filter((c) => !(isObject(c) && PLATFORM_COMMAND.test(`${c.name ?? ''} ${c.description ?? ''}`)))
    .map(scrubWord);
}

/**
 * The open-session snapshot's runtime state: the same command list at
 * `state.commands.value`, filtered, and every string (agent descriptions
 * from the starter template) naming the brand.
 */
function scrubSnapshotRuntime(runtime: unknown): unknown {
  if (!isObject(runtime) || !isObject(runtime.state) || !isObject(runtime.state.commands)) return scrubWord(runtime);
  const commands = runtime.state.commands;
  if (!Array.isArray(commands.value)) return scrubWord(runtime);
  return scrubWord({ ...runtime, state: { ...runtime.state, commands: { ...commands, value: scrubCommands(commands.value) } } });
}

/** Every `message` string in a turn state names the brand instead of Kortix. */
function scrubTurn(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubTurn);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      key === 'message' && typeof v === 'string' ? v.replace(KORTIX_WORD, BRAND.name) : scrubTurn(v),
    ]),
  );
}

/**
 * Every member token is the operator's Kortix user, so every name and email
 * Kortix returns for a person is the operator's. Lumen shows none of them:
 * the session record loses its owner name, email and avatar and its
 * initiator label; message authors and stops lose their `member` entries
 * ("Messages with no known sender are absent"), so the transcript draws no
 * "Sent by" or "Stopped by". Authors that are agent sessions stay. Git
 * history names Lumen as every author (`scrubGit`), a failed turn's error
 * copy names Lumen (`scrubTurn`), the slash-command list leaves out the
 * platform's own commands and names Lumen in the rest, and the project
 * record names Lumen (`scrubWord`).
 */
export function redactIdentity(path: string, body: unknown): unknown {
  if (RUNTIME_COMMANDS.test(path) && Array.isArray(body)) return scrubCommands(body);
  if (PROJECT_RECORD.test(path)) return scrubWord(body);
  if (!isObject(body)) return body;
  if (GIT_HISTORY.test(path)) return scrubGit(body);
  if (SESSION_TURN.test(path)) return scrubTurn(body);
  if (SESSION_RECORD.test(path)) return scrubSession(body);
  if (SESSION_SNAPSHOT.test(path)) {
    return {
      ...body,
      session: scrubSession(body.session),
      ...('turn' in body ? { turn: scrubTurn(body.turn) } : {}),
      ...('runtime' in body ? { runtime: scrubSnapshotRuntime(body.runtime) } : {}),
    };
  }
  if (!MESSAGE_AUTHORS.test(path)) return body;
  const keep = (map: unknown) =>
    isObject(map) ? Object.fromEntries(Object.entries(map).filter(([, a]) => notMember(a))) : map;
  return {
    ...body,
    authors: keep(body.authors),
    initial_author: notMember(body.initial_author) ? body.initial_author : null,
    ...('stops' in body ? { stops: keep(body.stops) } : {}),
  };
}
