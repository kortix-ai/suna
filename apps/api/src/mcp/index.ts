/**
 * The hosted Kortix MCP server: `POST /v1/mcp`, MCP Streamable HTTP (JSON
 * responses, stateless). One server per person, like the `kortix` CLI: it is
 * bound to the caller's token, never to a project, and reaches every account,
 * project and session that token can.
 *
 * Any MCP client adds the URL and signs in with OAuth ("Sign in with Kortix",
 * ../oauth): a `401` carries `WWW-Authenticate: Bearer resource_metadata=…`,
 * the client reads the RFC 9728 document, registers itself (RFC 7591), runs
 * the PKCE code flow, and returns with a `kortix_oat_` token that acts as the
 * user. A `kortix_pat_` (the CLI's token) works as a Bearer header too. Every
 * tool call runs through the real API routes in-process with that token, so
 * authorization is exactly the API's.
 */
import { Hono, type Context, type Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { supabaseAuth } from '../middleware/auth';
import { mcpResourceMetadataUrl, oauthIssuer } from '../oauth/discovery';
import { OAUTH_SCOPE_KORTIX } from '../oauth/access-token';
import { JOB_DEFAULT_TIMEOUT_SECONDS, JOB_MAX_TIMEOUT_SECONDS } from './jobs';
import { KORTIX_TOOL } from './cli';
import { CONNECTOR_TOOLS, isConnectorTool, runConnectorTool, type Host } from './connectors';
import { type Dispatch, type ToolContext, type ToolResult, text, ToolInputError, REQUEST_BUDGET_MS, callApi, apiResult, arg, optionalArg, projectArg, resolveSandbox, expandHome, callSandbox, type Sandbox } from './common';
import { dispatchProjects } from './projects';
import { dispatchSessions } from './sessions';
import { dispatchSandbox } from './sandbox';
import { dispatchPlatform } from './platform';
export { callSandbox, page, listSessionsQuery, startSessionBody, listSessionRow, type Sandbox, type ToolResult, type ApiReply } from './common';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SESSION_ID = { type: 'string', description: 'The session_id (UUID).' } as const;
const PROJECT_ID = { type: 'string', description: 'The project_id (UUID), from list_projects.' } as const;
const TOOLS = [
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'List every project you can open, across all your accounts: project_id, name, account, repository, your role. Start here: the other tools take a project_id or a session_id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'start_session',
    title: 'Start a session',
    description:
      'Start a Kortix session in a project with a first prompt. An agent runs it in its own cloud sandbox on its own git branch. Returns the session_id. Follow it with read_session and wait_seconds (the first turn needs ~10–60 s while the sandbox boots).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        prompt: { type: 'string', description: 'The task for the agent.' },
        name: { type: 'string', description: 'Optional session title.' },
        agent: { type: 'string', description: 'Optional agent name; the project default when omitted.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Optional free-form labels to classify the session (each 1-64 chars, at most 20). Filter by them with list_sessions labels.' },
        metadata: { type: 'object', description: 'Optional free-form JSON object stored on the session (at most 16,384 characters). Server-managed keys are refused.' },
      },
      required: ['project_id', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'send_message',
    title: 'Send a message to a session or to people',
    description:
      "Send a message to a session's agent (session_id), or to people (to + project_id). A session message waits in the session's inbox until the current turn ends, and a stopped session is started; read the reply with read_session and wait_seconds. Messaging people opens a new session whose first message is yours, shared with them; its agent runs when one of them replies. Several addresses make a group chat. Find people with kortix ['access','ls']. Needs the project's human_messaging feature flag.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ID,
        to: { type: 'array', items: { type: 'string' }, description: 'Email addresses of project members, instead of session_id.' },
        project_id: { ...PROJECT_ID, description: 'The project to open the conversation in. Required with `to`.' },
        text: { type: 'string', description: 'The message.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'read_session',
    title: 'Read a session',
    description:
      "Read a session: its status, whether a turn is running, and the latest messages with each tool call's input and output. wait_seconds blocks until the agent is idle (up to 45 s); call again while `turn` is not `idle` (`booting`, `running` or `queued`). Tool inputs and outputs are cut per part (marked `[truncated: N of M chars]`); when the messages do not fit, the oldest are dropped (`omitted_older`). `last_turn_error` names a failed turn. Older history: call_api on the session's transcript route with shape=sync.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ID,
        limit: { type: 'number', description: 'Latest messages to return (default 10, max 100). `message_count` is how many came back; `complete: true` means no older message exists.' },
        wait_seconds: { type: 'number', description: 'Wait up to this long (max 45) for the running turn to end before reading.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_sessions',
    title: 'List sessions',
    description:
      "List the top-level sessions you can see in a project, in the project's list order: id, title, labels, status, agent, owner, started_by (who started the run), child_count, branch, created_at, updated_at. Filter with started_by, labels and query (searches every session you can see, not only recent ones). A row with child_count > 0 has sub-sessions: pass its session_id as parent_session_id to list them. `next_cursor` is set when more exist: pass it back as `cursor`.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        limit: { type: 'number', description: 'Max sessions (default 20, max 200).' },
        cursor: { type: 'string', description: 'The next_cursor of the previous page (same filters).' },
        started_by: { type: 'string', enum: ['me', 'others', 'automated'], description: 'me = you started it; others = another member; automated = a trigger, channel or API key.' },
        query: { type: 'string', description: 'Case-insensitive text matched against title, starter, agent, owner and session id prefix (1-200 chars).' },
        parent_session_id: { type: 'string', description: 'List only the children of this session instead of top-level sessions.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Only sessions that carry every one of these labels (exact match). A top-level session also matches through a child.' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'run_command',
    title: 'Run a command in a session sandbox',
    description:
      "Run a bash command in a session's sandbox (its git checkout is /workspace) and return stdout, stderr (separate streams) and the exit code. A stopped sandbox is started first. A command may run for minutes: when it outlasts one call (~50 s), the result says `status: running` with a job_id and the output so far; call again with that job_id to keep waiting, or with cancel: true to stop it. The kortix CLI is preinstalled and signed in as the session.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ID,
        command: { type: 'string', description: 'A bash command line.' },
        cwd: { type: 'string', description: 'Working directory (default /workspace).' },
        timeout_seconds: { type: 'number', description: `Kill the command after this long (default ${JOB_DEFAULT_TIMEOUT_SECONDS}, max ${JOB_MAX_TIMEOUT_SECONDS}).` },
        job_id: { type: 'string', description: 'Keep waiting on a command an earlier call returned as still running (instead of command).' },
        cancel: { type: 'boolean', description: 'With job_id: stop that command.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'read_file',
    title: 'Read a file',
    description:
      "Read one file. With session_id: the session's live sandbox (uncommitted edits included; relative paths resolve under /workspace, `~` is the sandbox home; images come back as images; reads are limited to /workspace, the home directory and /tmp: use run_command for anything else). With project_id instead (session_id wins when both are given): the project's git repository at `ref` (default branch when omitted), no sandbox needed. A long text file comes back in pages of lines: `offset` (lines to skip) and `limit` (lines) read the next page. A binary file is not returned as text: use run_command (e.g. base64 -w0 file | cut -c 1-40000).",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, e.g. README.md or /workspace/src/index.ts.' },
        session_id: SESSION_ID,
        project_id: PROJECT_ID,
        ref: { type: 'string', description: 'Repository only: a branch, tag or commit.' },
        offset: { type: 'number', description: 'Text files: lines to skip (default 0). A cut result ends with the offset that continues it.' },
        limit: { type: 'number', description: 'Text files: max lines to return (default: as many as fit in ~50 000 characters).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'write_file',
    title: 'Write a file in a session sandbox',
    description:
      "Write a file in a session's sandbox, creating parent directories. Overwrites an existing file. `~` is the sandbox home. The agent and the session branch see it at once; commit it with run_command (git) or ask the agent.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ID,
        path: { type: 'string', description: 'File path; relative paths resolve under /workspace.' },
        content: { type: 'string', description: 'The whole new file content.' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'base64 for binary content (default utf8).' },
      },
      required: ['session_id', 'path', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_files',
    title: 'List files',
    description:
      "List files. With session_id: one directory of the session's live sandbox (default /workspace; absolute paths, `~` is the sandbox home). With project_id instead (session_id wins when both are given): every file of the project's git repository under `path` (recursive), at `ref`. A long list is cut; the result ends with the `offset` that continues it.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory (sandbox) or directory/file path in the repository (a leading / is the repository root).' },
        session_id: SESSION_ID,
        project_id: PROJECT_ID,
        ref: { type: 'string', description: 'Repository only: a branch, tag or commit.' },
        offset: { type: 'number', description: 'Entries to skip (default 0).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_skill',
    title: 'Read Kortix guides',
    description:
      "Read the Kortix platform guides (skills): how projects, sessions, agents, kortix.yaml, triggers, connectors, secrets, Apps, change requests and the CLI work. No name lists them; a name returns the guide and its reference file paths; file reads one reference. With project_id, the project's own skills come with them: no name lists both; a name returns that project skill's SKILL.md and its reference file paths (a project skill wins over a guide of the same name); file reads one of its references.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, e.g. kortix-system.' },
        file: { type: 'string', description: 'A reference file the guide names, e.g. references/cli.md.' },
        project_id: { ...PROJECT_ID, description: "Optional: include this project's own skills (from its skills/ directory)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'search_api',
    title: 'Search the Kortix API',
    description:
      'Search the Kortix API — the routes the web app and the kortix CLI use: accounts, projects, sessions, files, secrets, connectors, triggers, agents, models, change requests, Apps, access, billing, audit. Returns METHOD /path — summary lines. Follow with describe_api, then call_api.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "secrets", "trigger fire", "change request merge".' },
        limit: { type: 'number', description: 'Max results (default 20).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'describe_api',
    title: 'Describe an API route',
    description: "Show one API route's parameters, request body schema and success response schema.",
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'GET, POST, PUT, PATCH or DELETE.' },
        path: { type: 'string', description: 'The route as search_api printed it, e.g. /v1/projects/{projectId}/secrets.' },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'call_api',
    title: 'Call the Kortix API',
    description:
      'Call any Kortix API route as the signed-in user, with their permissions. {projectId} in the path is replaced with project_id; replace every other {placeholder} yourself, e.g. /v1/projects/{projectId}/secrets/MY_KEY. Returns `METHOD path → HTTP status` and the response body.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        project_id: { type: 'string', description: 'Fills {projectId} in the path.' },
        path: { type: 'string', description: 'Starts with /v1/, e.g. /v1/projects/{projectId}/sessions.' },
        query: { type: 'object', description: 'Query-string parameters; an array value repeats the parameter.' },
        body: { type: 'object', additionalProperties: true, description: 'JSON request body (an object; a JSON string is parsed).' },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
] as const;

async function runTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  for (const dispatch of [dispatchProjects, dispatchSessions, dispatchSandbox, dispatchPlatform]) {
    const result = await dispatch(ctx, name, input);
    if (result !== undefined) return result;
  }
  if (isConnectorTool(name)) return runConnectorTool(name, input, connectorHost(ctx));
  throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
}

/** What ./connectors.ts needs from this file: the in-process transport and the sandbox file read. */
const connectorHost = (ctx: ToolContext): Host => ({
  call: (method, path, opts) => callApi(ctx, method, path, opts),
  text,
  apiResult: (r) => apiResult(r),
  input: (message) => new ToolInputError(message),
  arg,
  optionalArg,
  projectId: projectArg,
  async readSandboxFile(sessionId, path) {
    const sandbox = await resolveSandbox(ctx, sessionId);
    if (!('session' in sandbox)) return apiResult(sandbox);
    const home = await expandHome(ctx, sandbox, path);
    if ('error' in home) return home.error;
    const r = await callSandbox(ctx, sandbox, 'GET', '/file/content', { query: { path: home.path } });
    if (r.status >= 400) return apiResult(r);
    const file = JSON.parse(r.body);
    // The daemon answers text as a string and everything else as base64.
    return { bytes: file.type === 'text' ? new TextEncoder().encode(file.content) : new Uint8Array(Buffer.from(file.content, 'base64')), mime: typeof file.mimeType === 'string' ? file.mimeType : undefined };
  },
});

function instructions(): string {
  return [
    'Kortix MCP. You act as the signed-in user, with their permissions, across every account and project they can open — the same reach as the kortix CLI.',
    'Start with list_projects. Tools take a project_id (start_session, list_sessions, repository reads) or a session_id (everything about one session).',
    'Sessions: start_session delegates a task to a Kortix agent in its own cloud sandbox; read_session (with wait_seconds) follows it; send_message continues it; list_sessions finds existing ones.',
    "Sandboxes: run_command runs bash in a session's sandbox, and read_file / write_file / list_files reach its live /workspace. With a project_id instead of a session_id, read_file and list_files read the project's git repository.",
    'Platform knowledge: read_skill lists the Kortix guides; read_skill name=kortix-system is the complete reference.',
    'Connectors (Gmail, Slack, GitHub, MCP servers, APIs a project connected): list_connectors shows what is connected and its accounts → search_connector_actions finds an action by intent → describe_connector_action reads its arguments → call_connector runs it as you (pass `reason` for a write whose args are only ids; a `pending_approval` result carries a link the human opens, then call again). A connector that is not connected: connect_connector returns the url the human opens. upload_connector_attachment stages a file for a call; search_connector_apps and add_connector add one to the project.',
    'The kortix CLI itself: the `kortix` tool runs any CLI command as you, e.g. args ["secrets","ls","--json"] (discover with ["--help"] and ["<group>","--help"]; project_id and session_id set the context). Login, hosts, ship, tui and other machine-local commands are refused with the alternative. read_skill with project_id also lists the project\'s own skills.',
    'Everything else the web app and the kortix CLI can do is the Kortix API: search_api finds a route, describe_api reads it, call_api runs it (project_id fills {projectId}).',
  ].join('\n');
}

// ─── JSON-RPC ───────────────────────────────────────────────────────────────

async function handleRpc(ctx: ToolContext, method: string, params: Record<string, any>): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const requested = String(params.protocolVersion ?? '');
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0]!,
        serverInfo: { name: 'kortix', title: 'Kortix', version: process.env.KORTIX_VERSION ?? 'dev' },
        capabilities: { tools: {} },
        instructions: instructions(),
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [...TOOLS, ...CONNECTOR_TOOLS, KORTIX_TOOL] };
    case 'tools/call': {
      if (typeof params.name !== 'string') throw Object.assign(new Error('Invalid params: name must be a tool name'), { rpcCode: -32602 });
      try {
        return await runTool(ctx, params.name, (params.arguments as Record<string, unknown>) ?? {});
      } catch (err) {
        if (err instanceof ToolInputError) return text(err.message, true);
        throw err;
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
  }
}

/**
 * Turns the auth middleware's 401 into the challenge MCP clients follow to find
 * the authorization server (RFC 9728 §5.1). URLs come from KORTIX_URL, never
 * from the request (learnings 2026-08-19).
 */
function challengeUnauthorized(c: Context, next: Next) {
  const metadata = `resource_metadata="${mcpResourceMetadataUrl(new URL(c.req.url).origin)}"`;
  const sent = Boolean(c.req.header('Authorization')?.startsWith('Bearer '));
  // RFC 6750 3.1: a token that was sent and refused names `invalid_token`.
  const challenge = () =>
    c.json({ error: 'unauthorized', error_description: 'Sign in with OAuth, or send a kortix_pat_ token, to use the Kortix MCP server.' }, 401, {
      'WWW-Authenticate': `Bearer ${sent ? 'error="invalid_token", ' : ''}${metadata}, scope="${OAUTH_SCOPE_KORTIX}"`,
    });
  if (!sent) return challenge();
  return supabaseAuth(c, next).catch((err) => {
    if (err instanceof HTTPException && err.status === 401) return challenge();
    // A token without the `kortix` scope: tell the client which scope to ask for.
    if (err instanceof HTTPException && err.status === 403 && err.message.startsWith('insufficient_scope')) {
      return c.json({ error: 'insufficient_scope', error_description: err.message }, 403, {
        'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${OAUTH_SCOPE_KORTIX}", ${metadata}`,
      });
    }
    throw err;
  });
}

const PARSE_ERROR = Symbol('parse error');

export function createMcpApp(dispatch: Dispatch) {
  const app = new Hono();

  app.post('/', challengeUnauthorized, async (c) => {
    const reject = (id: unknown, code: number, message: string) => c.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, 400);
    const message = await c.req.json().catch(() => PARSE_ERROR);
    if (message === PARSE_ERROR) return reject(null, -32700, 'Parse error');
    if (Array.isArray(message)) return reject(null, -32600, 'Invalid Request: batches are not supported; send one message per request');
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return reject(null, -32600, 'Invalid Request: jsonrpc must be "2.0"');
    // A response from the client (the server sends no requests): accepted, nothing to answer.
    if (typeof message.method !== 'string') {
      return 'result' in message || 'error' in message ? c.body(null, 202) : reject(message.id, -32600, 'Invalid Request: method is required');
    }
    const version = c.req.header('MCP-Protocol-Version');
    if (version !== undefined && message.method !== 'initialize' && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      return reject(message.id, -32600, `Unsupported MCP-Protocol-Version ${version}; supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`);
    }
    // A notification: accepted, nothing to answer.
    if (message.id === undefined || message.id === null) return c.body(null, 202);

    const ctx: ToolContext = {
      authorization: c.req.header('Authorization')!,
      origin: oauthIssuer(new URL(c.req.url).origin),
      headers: c.req.raw.headers,
      dispatch,
      deadline: Date.now() + REQUEST_BUDGET_MS,
    };
    try {
      const result = await handleRpc(ctx, message.method, message.params ?? {});
      return c.json({ jsonrpc: '2.0', id: message.id, result });
    } catch (err) {
      const e = err as Error & { rpcCode?: number };
      return c.json({ jsonrpc: '2.0', id: message.id, error: { code: e.rpcCode ?? -32603, message: e.message } });
    }
  });

  // Stateless server: no SSE stream to open, no session to delete.
  app.on(['GET', 'DELETE'], '/', (c) => c.json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' }));

  return app;
}
