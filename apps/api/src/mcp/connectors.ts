/**
 * The project's connectors on the hosted MCP server: the `kortix connectors`
 * CLI as MCP tools. Every tool calls the SAME REST route the SDK
 * (`packages/sdk/src/core/rest/projects-client/connectors.ts`) and the CLI call,
 * in-process as the caller, so authorization, policies, approvals and the audit
 * are exactly the API's. This module holds the tool definitions and their
 * shaping; `index.ts` hands it the in-process transport (`Host`) so there is no
 * import cycle.
 */
import type { ApiReply, ToolResult } from './index';

export interface Host {
  call(
    method: string,
    path: string,
    opts?: { query?: Record<string, unknown>; body?: unknown; raw?: { body: Uint8Array; headers: Record<string, string> } },
  ): Promise<ApiReply>;
  text(value: string, isError?: boolean): ToolResult;
  apiResult(reply: ApiReply): ToolResult;
  /** A failure the caller can fix: becomes an `isError` result. */
  input(message: string): Error;
  arg(input: Record<string, unknown>, key: string): string;
  optionalArg(input: Record<string, unknown>, key: string): string | undefined;
  projectId(input: Record<string, unknown>): string;
  /** The bytes of a file in a session's sandbox, or the error result. */
  readSandboxFile(sessionId: string, path: string): Promise<{ bytes: Uint8Array; mime?: string } | ToolResult>;
}

/** A call's `data`, and a describe's schema, stay under this so the JSON around them is never cut. */
export const MAX_DATA_CHARS = 40_000;
const FRONTEND_NOTE = 'The human opens the url in a browser, names the account and signs in with the provider.';

const PROJECT_ID = { type: 'string', description: 'The project_id (UUID), from list_projects.' } as const;
const CONNECTOR = { type: 'string', description: 'Connector slug, e.g. "gmail" (list_connectors shows them).' } as const;
const TOOL = {
  type: 'string',
  description: 'The action id `<connector>.<action>`, exactly as search_connector_actions printed it, e.g. "gmail.send_email". The action part may contain dots.',
} as const;

export const CONNECTOR_TOOLS = [
  {
    name: 'list_connectors',
    title: 'List connectors',
    description:
      'List the connectors of a project (Gmail, Slack, GitHub, MCP servers, OpenAPI/HTTP APIs, …): slug, name, provider, status, whether it is `connected` (usable by you now), its action count and its accounts. A connector that is not connected cannot run actions: call connect_connector, give the human the url, then list again. Pass `connector` to get one connector\'s accounts in full (label, owner shared|private, default, connected_as, connection_id): a connector can hold several accounts and a call with several and no default needs `account`. Flow: list_connectors → search_connector_actions → describe_connector_action → call_connector.',
    inputSchema: {
      type: 'object',
      properties: { project_id: PROJECT_ID, connector: { ...CONNECTOR, description: 'Optional: one connector slug, to get its accounts in full.' } },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'search_connector_actions',
    title: 'Search connector actions',
    description:
      'Find connector actions by intent across the project\'s connected connectors, e.g. "send an email" or "create a github issue". Returns up to `limit` matches as `tool` (`<connector>.<action>`, the id for describe_connector_action and call_connector), `risk` (read, write or destructive; writes and destructive actions usually wait for a human approval) and a one-line description. Never returns schemas: call describe_connector_action for the arguments. Omit `query` to list the first actions. Only connected connectors are searched: an unknown connector is in list_connectors with `connected: false`.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        query: { type: 'string', description: 'What you want to do, in plain words. Every word must appear in the action id or description.' },
        connector: { ...CONNECTOR, description: 'Optional: search only this connector.' },
        limit: { type: 'number', description: 'Maximum matches (default 20, max 100).' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'describe_connector_action',
    title: 'Describe a connector action',
    description:
      'Read one connector action in full: its input JSON Schema (the exact `args` call_connector takes), risk, description, and the connector\'s accounts. Always describe an action you have not called before. GraphQL actions take the selected fields in an `__select` arg, e.g. {"id":"1","__select":"id name"}.',
    inputSchema: {
      type: 'object',
      properties: { project_id: PROJECT_ID, tool: TOOL },
      required: ['project_id', 'tool'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'call_connector',
    title: 'Call a connector action',
    description:
      'Run one connector action as the signed-in user. Kortix adds the credential server-side, applies the project\'s policies and records an audit entry. `args` must match describe_connector_action. Results: (1) success: `{ok:true, account, risk, data}`, where `account` is the connected account that ran it (say which one you used); (2) `pending_approval`: a policy holds the call for a human. Give the human `approval_url` (and `approval_summary`), wait for them to approve, then call again with the SAME tool, args and account within 15 minutes: the approved call then runs once. (3) `denied`: `reason` says why (`policy_block` = the project blocks this action, do not retry; `connector_not_connected` = call connect_connector; `account_required` = several accounts and no default, retry with `account` set to one of `available_accounts`). ALWAYS pass `reason` for a write whose args are only ids (send_draft, delete, update by id): say what it does, e.g. who a draft goes to and what it says. The approver sees it, labelled as your description, next to the real args. Data over ~40 000 characters comes back cut, marked `data_truncated`, with a preview: narrow the args (fields, filters, page size) and call again. To attach a file, stage it with upload_connector_attachment and put the returned ref in `args`; never paste base64 into `args`.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        tool: TOOL,
        args: { type: 'object', additionalProperties: true, description: 'Arguments matching the action\'s input schema (a JSON string is parsed). Defaults to {}.' },
        account: {
          type: 'string',
          description:
            'Which connected account to run as, when the connector has several: a label or connection_id from list_connectors, or `me` (your own default private account) or `project` (the project\'s default shared account). Omit for the default. A name that matches nothing is refused with the available names; it never falls back to another account.',
        },
        reason: {
          type: 'string',
          description: 'What this call does, in plain words, shown to the human when a policy holds it for approval. Shown as unverified; never sent to the provider.',
        },
      },
      required: ['project_id', 'tool'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'upload_connector_attachment',
    title: 'Upload a connector attachment',
    description:
      'Stage one file for a connector call and get back `ref`, the value {"$kortix_attachment": "<id>"}. Put `ref` in call_connector `args`: as an element of the action\'s `attachments` array (Microsoft Graph sendMail, SendGrid, Postmark, … : the gateway builds the provider\'s attachment item), or as the value of a string field such as `contentBytes` (it becomes the file\'s base64). Give the file as `content_base64` (small files: the bytes pass through you) or as `session_id` + `path` (a file in that session\'s sandbox, read server-side: prefer this for anything large). A staged file is single-use and expires (`expires_at`). Composio and legacy Pipedream connectors do not accept refs.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        connector: { ...CONNECTOR, description: 'Slug of the connector the file is for, e.g. "microsoft-graph". You must be able to use it.' },
        filename: { type: 'string', description: 'The recipient-visible file name.' },
        content_type: { type: 'string', description: 'MIME type (default application/octet-stream, or the sandbox\'s for a session file).' },
        content_base64: { type: 'string', description: 'The file bytes, base64. Use this or session_id + path.' },
        session_id: { type: 'string', description: 'A session_id (UUID) whose sandbox holds the file.' },
        path: { type: 'string', description: 'Absolute path of the file in that session\'s sandbox.' },
      },
      required: ['project_id', 'connector', 'filename'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'connect_connector',
    title: 'Connect a connector',
    description:
      'Start authorizing a connector and return the `url` the HUMAN must open (show it to them; you cannot complete it). In the browser they name the account, choose who can use it and sign in with the provider. Then call list_connectors: the connector shows `connected: true`. The connector must already be in the project (add_connector). `owner`: "me" (default: an account only that human can use) or "project" (shared with every member; needs the connection-manage permission, and ask the human first: everyone in the project can then act as that identity). A connector with an API key instead of an OAuth sign-in is not connected this way: the human sets its credential in Kortix.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        connector: CONNECTOR,
        owner: { type: 'string', enum: ['me', 'project'], description: 'Whose account it becomes (default "me").' },
        label: { type: 'string', description: 'A name to prefill for the new account, e.g. "Support inbox".' },
      },
      required: ['project_id', 'connector'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'search_connector_apps',
    title: 'Search connector apps',
    description:
      'Search the catalogue of managed apps (Composio toolkits: Gmail, Slack, GitHub, Notion, Linear, …) a new connector can be added from. Returns slug, name, description, categories and whether the app is already connected. Pass the slug to add_connector as `app`. Returns `cursor` when more exist: pass it back as `cursor`.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        query: { type: 'string', description: 'App name or keyword, e.g. "calendar".' },
        limit: { type: 'number', description: 'Maximum apps (default 20, max 100).' },
        cursor: { type: 'string', description: 'The `cursor` of the previous page.' },
      },
      required: ['project_id', 'query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'add_connector',
    title: 'Add a connector',
    description:
      'Add (or update) a connector on the project now: it is committed to kortix.yaml on main and synced, like the dashboard\'s "Add app". For a managed app (Gmail, Slack, GitHub, …) pass `app` = the slug from search_connector_apps; the provider is Composio and the slug defaults to the app. For your own server pass `provider` and `slug` with `url` (mcp, plus `transport` http|sse), `endpoint` (graphql), `spec` (openapi, postman) or `base_url` (http). The result says what is next: call connect_connector for an OAuth app; an API-key connector needs its credential set by the human in Kortix. To remove a connector call remove_connector. Needs the connector-write permission.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        app: { type: 'string', description: 'Composio toolkit slug from search_connector_apps, e.g. "gmail".' },
        slug: { type: 'string', description: 'The connector\'s name in kortix.yaml (lowercase letters, digits, - and _). Defaults to `app`.' },
        provider: { type: 'string', enum: ['composio', 'mcp', 'openapi', 'postman', 'graphql', 'http'], description: 'Default composio when `app` is given; required otherwise.' },
        name: { type: 'string', description: 'Display name.' },
        url: { type: 'string', description: 'MCP server URL (provider mcp).' },
        transport: { type: 'string', enum: ['http', 'sse'], description: 'MCP transport (provider mcp).' },
        endpoint: { type: 'string', description: 'GraphQL endpoint (provider graphql).' },
        spec: { type: 'string', description: 'OpenAPI or Postman spec URL (provider openapi, postman).' },
        base_url: { type: 'string', description: 'Base URL (provider http, or openapi without a server).' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'remove_connector',
    title: 'Remove a connector',
    description:
      'Remove a connector from the project: it is deleted from kortix.yaml on main and from the catalog, and its actions stop working for everyone. Needs the connector-write permission. Ask the human before removing one.',
    inputSchema: {
      type: 'object',
      properties: { project_id: PROJECT_ID, connector: CONNECTOR },
      required: ['project_id', 'connector'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
] as const;

const NAMES = new Set<string>(CONNECTOR_TOOLS.map((t) => t.name));
export const isConnectorTool = (name: string) => NAMES.has(name);

// ─── Pure shaping (unit-tested in connectors.test.ts) ───────────────────────

interface CatalogAction { path: string; name?: string; description?: string; risk: string; inputSchema?: unknown }
interface CatalogAccount { connection_id: string; label: string; owner_type: string; is_default: boolean; connected_as?: string | null }
interface CatalogEntry { slug: string; name: string; provider: string; status: string; actions: CatalogAction[]; accounts?: CatalogAccount[]; default_account?: string | null }

/** `<connector>.<action>`: the slug has no dot, the action may. */
export function splitTool(tool: string): { connector: string; action: string } | null {
  const dot = tool.indexOf('.');
  const connector = dot < 0 ? '' : tool.slice(0, dot).trim();
  const action = dot < 0 ? '' : tool.slice(dot + 1).trim();
  return connector && action ? { connector, action } : null;
}

const oneLine = (s: string, max = 200) => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The ranking of the SDK's `searchConnectorTools`: whole-phrase matches first, then every-word matches. */
export function searchActions(catalog: CatalogEntry[], query: string, limit: number) {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const exact: unknown[] = [];
  const partial: unknown[] = [];
  for (const c of catalog) {
    for (const a of c.actions) {
      const tool = `${c.slug}.${a.path}`;
      const hay = `${tool} ${a.description || a.name || ''}`.toLowerCase();
      const row = { tool, risk: a.risk, description: oneLine(a.description || a.name || '') };
      if (!q || hay.includes(q)) exact.push(row);
      else if (words.every((w) => hay.includes(w))) partial.push(row);
    }
  }
  const all = [...exact, ...partial];
  return { matches: all.slice(0, limit), total: all.length };
}

export const accountRow = (a: CatalogAccount) => ({
  label: a.label,
  owner: a.owner_type === 'member' ? 'private' : 'shared',
  default: a.is_default,
  connected_as: a.connected_as ?? null,
  connection_id: a.connection_id,
});

/** JSON whose big part is replaced, never cut: the reply is always parseable. */
export function fitData(head: Record<string, unknown>, key: string, value: unknown, max = MAX_DATA_CHARS): string {
  const json = JSON.stringify(value) ?? 'null';
  if (json.length <= max) return JSON.stringify({ ...head, [key]: value }, null, 2);
  return JSON.stringify(
    {
      ...head,
      [`${key}_truncated`]: true,
      [`${key}_chars`]: json.length,
      [`${key}_preview`]: json.slice(0, max),
      note: `The ${key} is ${json.length} characters; only the first ${max} are shown, as a string. Narrow the request (fields, filters, page size) and call again.`,
    },
    null,
    2,
  );
}

/** What to do next for a denial, in MCP tool names. */
export function denialNext(reason: string, body: any): string | undefined {
  switch (reason) {
    case 'policy_block':
      return 'The project blocks this action by policy. Do not retry; tell the human, who can change the policy in the project\'s connector settings.';
    case 'connector_not_connected':
      return body?.available_accounts?.length
        ? 'Retry with `account` set to one of available_accounts, or omit it for the default.'
        : 'Call connect_connector for this connector, give the human the url, then list_connectors to confirm.';
    case 'account_required':
      return 'Several accounts are connected and none is the default: retry with `account` set to one of available_accounts (or ask the human which).';
    case 'connector_not_assigned':
      return 'The agent or token behind this call is not granted this connector.';
    case 'connector_not_found':
      return 'No such connector in this project: list_connectors shows the slugs, add_connector adds one.';
    case 'action_not_found':
      return 'No such action: search_connector_actions finds the right `tool` id.';
    default:
      return undefined;
  }
}

const parse = (body: string): any => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/** Standard base64 the API accepts; lenient decoders would write junk bytes. */
const validBase64 = (s: string) => /^[A-Za-z0-9+/=\s]*$/.test(s) && s.replace(/[=\s]/g, '').length % 4 !== 1;

// ─── The tools ──────────────────────────────────────────────────────────────

export async function runConnectorTool(name: string, input: Record<string, unknown>, h: Host): Promise<ToolResult> {
  const pid = h.projectId(input);
  const base = `/v1/connectors/projects/${pid}`;
  const catalog = (query: Record<string, unknown>) => h.call('GET', `${base}/catalog`, { query });

  switch (name) {
    case 'list_connectors': {
      const only = h.optionalArg(input, 'connector');
      const [cat, admin, accounts] = await Promise.all([
        catalog({ include_schemas: false, slug: only }),
        h.call('GET', `${base}/connectors`, { query: { include_schemas: false } }),
        only ? h.call('GET', `${base}/connectors/${encodeURIComponent(only)}/accounts`) : Promise.resolve(null),
      ]);
      if (cat.status >= 400) return h.apiResult(cat);
      const usable = new Map<string, CatalogEntry>((parse(cat.body)?.connectors ?? []).map((c: CatalogEntry) => [c.slug, c]));
      // The admin list also holds connectors nobody has connected; a member
      // without read access to it still gets the usable ones from the catalog.
      const known: CatalogEntry[] = admin.status < 400 ? (parse(admin.body)?.connectors ?? []) : [...usable.values()];
      const rows = known
        .filter((c) => !only || c.slug === only)
        .map((c) => {
          const live = usable.get(c.slug);
          const connected = live !== undefined;
          const row: Record<string, unknown> = {
            slug: c.slug,
            name: c.name,
            provider: c.provider,
            status: c.status,
            connected,
            actions: (live ?? c).actions.length,
            accounts: (live?.accounts ?? c.accounts ?? []).map(accountRow),
            default_account: live?.default_account ?? c.default_account ?? null,
          };
          if (!connected) {
            row.next = c.status === 'disabled'
              ? 'Disabled in kortix.yaml: its actions cannot run.'
              : 'Not connected: call connect_connector, give the human the url, then list_connectors again.';
          }
          return row;
        });
      if (only && rows.length === 0) return h.text(`No connector "${only}" in this project. list_connectors without \`connector\` shows every slug; add_connector adds one.`, true);
      // The per-connector accounts route is the authority for one connector: it lists what THIS caller may run as.
      if (only && accounts && accounts.status < 400 && rows[0]) {
        const listed = parse(accounts.body);
        rows[0].accounts = (listed?.accounts ?? []).map(accountRow);
        rows[0].default_account = listed?.default_account ?? null;
      }
      return h.text(JSON.stringify({ connectors: rows }, null, 2));
    }
    case 'search_connector_actions': {
      const only = h.optionalArg(input, 'connector');
      const limit = Math.min(Math.max(Math.trunc(Number(input.limit)) || 20, 1), 100);
      const cat = await catalog({ include_schemas: false, slug: only });
      if (cat.status >= 400) return h.apiResult(cat);
      let entries: CatalogEntry[] = parse(cat.body)?.connectors ?? [];
      // An API that predates the `slug` filter answers the whole catalog.
      if (only) entries = entries.filter((c) => c.slug === only);
      const found = searchActions(entries, h.optionalArg(input, 'query') ?? '', limit);
      const empty = found.total === 0
        ? only && entries.length === 0
          ? `Connector "${only}" is not connected or does not exist: list_connectors shows its state.`
          : 'No matching action. Try other words, or list_connectors for what is connected.'
        : undefined;
      return h.text(JSON.stringify({ ...found, ...(found.total > limit ? { more: `${found.total - limit} more: narrow the query or raise limit` } : {}), ...(empty ? { note: empty } : {}) }, null, 2));
    }
    case 'describe_connector_action': {
      const tool = h.arg(input, 'tool');
      const parts = splitTool(tool);
      if (!parts) throw h.input('tool must use the `<connector>.<action>` format, e.g. "gmail.send_email"');
      const cat = await catalog({ slug: parts.connector, include_schemas: true });
      if (cat.status >= 400) return h.apiResult(cat);
      // Match by slug, never take the first entry: an API without the filter answers everything.
      const connector = ((parse(cat.body)?.connectors ?? []) as CatalogEntry[]).find((c) => c.slug === parts.connector);
      if (!connector) return h.text(`Connector "${parts.connector}" is not connected or does not exist: list_connectors shows its state.`, true);
      const action = connector.actions.find((a) => a.path === parts.action);
      if (!action) {
        const near = connector.actions.filter((a) => a.path.includes(parts.action.split('.')[0]!)).slice(0, 10).map((a) => `${connector.slug}.${a.path}`);
        return h.text(`No action "${parts.action}" on ${connector.slug} (${connector.actions.length} actions). search_connector_actions with connector="${connector.slug}" finds it.${near.length ? ` Similar: ${near.join(', ')}` : ''}`, true);
      }
      return h.text(
        fitData(
          {
            tool,
            risk: action.risk,
            description: action.description || action.name || '',
            accounts: (connector.accounts ?? []).map(accountRow),
            default_account: connector.default_account ?? null,
          },
          'input_schema',
          action.inputSchema ?? null,
        ),
      );
    }
    case 'call_connector': {
      const parts = splitTool(h.arg(input, 'tool'));
      if (!parts) throw h.input('tool must use the `<connector>.<action>` format, e.g. "gmail.send_email"');
      let args = input.args ?? {};
      // A client that types `args` as a string sends JSON text: parse it, never double-encode it.
      if (typeof args === 'string') args = parse(args) ?? args;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw h.input('args must be a JSON object');
      const account = h.optionalArg(input, 'account');
      const reason = h.optionalArg(input, 'reason');
      const r = await h.call('POST', `${base}/call`, {
        body: { connector: parts.connector, action: parts.action, args, ...(account ? { account } : {}), ...(reason ? { approval_context: reason } : {}) },
      });
      const body = parse(r.body);
      if (!body || typeof body !== 'object') return h.apiResult(r);
      if (r.status < 400 && body.ok === true) {
        // `output` repeats `data` without its envelope; only `data` is fitted.
        const { data, output: _output, ...head } = body;
        return h.text(fitData(head, 'data', data));
      }
      if (body.status === 'pending_approval') {
        return h.text(
          JSON.stringify(
            {
              ...body,
              next: body.approval_url
                ? 'Give the human approval_url (and approval_summary). When they approve, call call_connector again with the same tool, args and account within 15 minutes: the approved call runs once. If they deny, do not retry.'
                : 'A human must approve this call in the Kortix web app (the project\'s approvals). Then call again with the same tool, args and account within 15 minutes.',
            },
            null,
            2,
          ),
        );
      }
      const next = denialNext(String(body.reason ?? ''), body);
      return h.text(JSON.stringify({ ...body, ...(next ? { next } : {}) }, null, 2), true);
    }
    case 'upload_connector_attachment': {
      const filename = h.arg(input, 'filename');
      const connector = h.arg(input, 'connector');
      const b64 = h.optionalArg(input, 'content_base64');
      const sessionId = h.optionalArg(input, 'session_id');
      const path = h.optionalArg(input, 'path');
      if (b64 !== undefined && (sessionId || path)) throw h.input('pass content_base64, or session_id + path, not both');
      let bytes: Uint8Array;
      let mime = h.optionalArg(input, 'content_type');
      if (b64 !== undefined) {
        if (!validBase64(b64)) throw h.input('content_base64 is not valid base64; nothing was uploaded');
        bytes = new Uint8Array(Buffer.from(b64, 'base64'));
      } else {
        if (!sessionId || !path) throw h.input('pass content_base64, or session_id and path of a file in that session\'s sandbox');
        const file = await h.readSandboxFile(sessionId, path);
        if (!('bytes' in file)) return file;
        bytes = file.bytes;
        mime ??= file.mime;
      }
      if (bytes.byteLength === 0) throw h.input('the file is empty');
      const r = await h.call('POST', `${base}/attachments`, {
        raw: {
          body: bytes,
          headers: {
            'content-type': mime || 'application/octet-stream',
            'x-kortix-attachment-filename': encodeURIComponent(filename),
            'x-kortix-attachment-disposition': 'attachment',
            'x-kortix-attachment-connector': encodeURIComponent(connector),
          },
        },
      });
      const up = parse(r.body);
      if (r.status >= 400 || !up?.attachment_id) return h.apiResult(r);
      const ref = up.ref ?? { $kortix_attachment: up.attachment_id };
      return h.text(
        JSON.stringify(
          {
            ...up,
            ref,
            use: 'Put `ref` in call_connector `args`: as an element of the action\'s attachments[] array, or as the value of a string field (contentBytes, content). The file is single-use and expires at expires_at.',
          },
          null,
          2,
        ),
      );
    }
    case 'connect_connector': {
      const slug = h.arg(input, 'connector');
      const owner = h.optionalArg(input, 'owner');
      if (owner !== undefined && owner !== 'me' && owner !== 'project') throw h.input('owner must be "me" or "project"');
      const label = h.optionalArg(input, 'label');
      // OUR setup link (`<frontend>/connect/<token>`) is the one the web app turns into the Connect button
      // and resumes; the provider's own page has neither (see apps/cli/src/connector-gateway/gateway.ts).
      const link = await h.call('POST', `/v1/projects/${pid}/connect-requests`, {
        body: { slug, ...(owner ? { owner } : {}), ...(label ? { label } : {}) },
      });
      const made = parse(link.body);
      if (link.status < 400 && made?.url) {
        return h.text(
          JSON.stringify(
            { connector: slug, url: made.url, owner: made.owner ?? owner ?? 'me', expires_at: made.expires_at, next: `Show the url to the human. ${FRONTEND_NOTE} Then call list_connectors: the connector shows connected: true.` },
            null,
            2,
          ),
        );
      }
      // The caller's own mistake or missing permission is final; anything else (a provider without a hosted
      // setup page) falls back to the provider's authorization url, as the CLI does.
      if ([400, 401, 403, 404].includes(link.status)) return h.apiResult(link);
      const started = await h.call('POST', `${base}/connectors/${encodeURIComponent(slug)}/connect`, { body: owner ? { owner } : {} });
      const s = parse(started.body);
      if (started.status >= 400 || !s) return h.apiResult(started);
      if (s.connected === true || s.isNoAuth === true) {
        return h.text(JSON.stringify({ connector: slug, connected: true, next: 'Nothing to authorize: the connector is usable. list_connectors shows it.' }, null, 2));
      }
      return h.text(
        JSON.stringify(
          {
            connector: slug,
            url: s.connectUrl ?? null,
            connection_id: s.connectionId ?? null,
            request_id: s.requestId ?? null,
            next: `Show the url to the human; they finish authorizing in the browser. Then call list_connectors: the connector shows connected: true. If it does not, confirm the authorization with call_api POST /v1/connectors/projects/{projectId}/connectors/${slug}/connect/finalize and body {"connection_id":"<connection_id>","request_id":"<request_id>"}.`,
          },
          null,
          2,
        ),
      );
    }
    case 'search_connector_apps': {
      const limit = Math.min(Math.max(Math.trunc(Number(input.limit)) || 20, 1), 100);
      const r = await h.call('GET', `${base}/connect/toolkits`, { query: { q: h.arg(input, 'query'), limit, cursor: h.optionalArg(input, 'cursor') } });
      if (r.status >= 400) return h.apiResult(r);
      const page = parse(r.body) ?? {};
      const apps = ((page.items ?? []) as any[]).map((a) => ({
        slug: a.slug,
        name: a.name,
        description: oneLine(a.description ?? '', 160),
        categories: a.categories ?? [],
        connected: a.connection?.isActive === true,
      }));
      return h.text(
        JSON.stringify(
          { apps, cursor: page.cursor ?? null, next: apps.length ? 'add_connector with app=<slug> adds one to the project.' : 'No app matches: try another word.' },
          null,
          2,
        ),
      );
    }
    case 'add_connector': {
      const app = h.optionalArg(input, 'app');
      const provider = h.optionalArg(input, 'provider') ?? (app ? 'composio' : undefined);
      const slug = h.optionalArg(input, 'slug') ?? app;
      if (!provider || !slug) throw h.input('pass `app` (a managed app from search_connector_apps), or `provider` and `slug` for your own server');
      const draft: Record<string, unknown> = { slug, provider };
      for (const [from, to] of [['app', 'app'], ['name', 'name'], ['url', 'url'], ['transport', 'transport'], ['endpoint', 'endpoint'], ['spec', 'spec'], ['base_url', 'baseUrl']] as const) {
        const v = h.optionalArg(input, from);
        if (v) draft[to] = v;
      }
      const r = await h.call('POST', `${base}/connectors`, { body: draft });
      if (r.status >= 400) return h.apiResult(r);
      const done = parse(r.body) ?? {};
      const oauth = provider === 'composio';
      return h.text(
        JSON.stringify(
          {
            connector: slug,
            live: true,
            sync: done.sync ?? null,
            auth_detected: done.authDiscovery?.recommended?.type ?? null,
            next: oauth
              ? `Live on the project (committed to kortix.yaml on main). Call connect_connector for "${slug}" and give the human the url.`
              : `Live on the project (committed to kortix.yaml on main). If it needs a credential, the human sets it in Kortix (project connector settings); then list_connectors shows connected: true.`,
          },
          null,
          2,
        ),
      );
    }
    case 'remove_connector': {
      const slug = h.arg(input, 'connector');
      const r = await h.call('DELETE', `${base}/connectors/${encodeURIComponent(slug)}`);
      if (r.status >= 400) return h.apiResult(r);
      return h.text(JSON.stringify({ connector: slug, removed: true, note: 'Deleted from kortix.yaml on main and from the catalog.' }, null, 2));
    }
    default:
      throw h.input(`Unknown connector tool: ${name}`);
  }
}
