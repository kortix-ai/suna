/**
 * Execution of the `connectors` MCP meta-tools.
 *
 * `runMetaTool` is the one dispatcher: it validates each tool's arguments,
 * calls the gateway client, and wraps every failure in one of the two result
 * envelopes — the structured one (`connectorErrorPayload`, which hands the
 * API body back verbatim) for `call`/`upload_attachment`, and the plain one
 * (`error: message`) everywhere else, via the single `plainToolError`
 * boundary. The stdio JSON-RPC transport lives in mcp.ts, the catalog in
 * mcp-tools.ts.
 */
import {
  attachmentRef,
  attachmentSlot,
  insertAttachmentHandles,
  uploadAttachmentFiles,
} from './attachments.ts';
import {
  type BrokerMethod,
  type ConnectorClient,
  type SecretLinkResult,
  addConnector,
  brokerSecretRequest,
  callWithApprovalHandoff,
  finalizeConnectorConnection,
  mintConnectLink,
  mintSecretLink,
  removeConnector,
  setSecrets,
} from './gateway.ts';
import { connectorErrorPayload } from './io.ts';
import { spillLargeResult } from './result-spill.ts';

const BROKER_METHODS: BrokerMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** The one plain-error boundary: the thrown message IS the whole payload. */
function plainToolError(err: unknown) {
  return {
    content: content({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    isError: true,
  };
}

/** One account, as summarized on `connectors` / `describe` tool output. */
interface AccountSummaryEntry {
  label: string;
  /** `private` = one member's own account. `shared` = the project's account. */
  owner: 'shared' | 'private';
  default: boolean;
  connection_id: string;
}

/** `private` for a member-owned account, `shared` for everything else (the project's). */
function ownerKind(ownerType: string): 'shared' | 'private' {
  return ownerType === 'member' ? 'private' : 'shared';
}

/**
 * Summarize a connector's accounts for a meta-tool result: the
 * label/owner/default table, `default_account`, and — only when there is a
 * real choice to make (more than one account) — `how_to_choose`, a
 * copy-pasteable `call` shape naming the default.
 */
function accountsSummary(
  connector: string,
  accounts: ReadonlyArray<{
    connection_id: string;
    label: string;
    owner_type: string;
    is_default: boolean;
  }>,
  defaultLabel: string | null,
): { accounts: AccountSummaryEntry[]; default_account: string | null; how_to_choose?: string } {
  const entries: AccountSummaryEntry[] = accounts.map((a) => ({
    label: a.label,
    owner: ownerKind(a.owner_type),
    default: a.is_default,
    connection_id: a.connection_id,
  }));
  const resolvedDefault = defaultLabel ?? entries[0]?.label ?? null;
  return {
    accounts: entries,
    default_account: resolvedDefault,
    ...(entries.length > 1 && resolvedDefault
      ? {
          how_to_choose: `call {connector: "${connector}", action: "<action>", account: "${resolvedDefault}"}`,
        }
      : {}),
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function content(data: unknown) {
  return [
    {
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    },
  ];
}

export async function runMetaTool(
  client: ConnectorClient,
  name: string,
  args: Record<string, unknown>,
) {
  switch (name) {
    case 'connectors': {
      // The summary reads no `inputSchema` — opt out, or the API's
      // include-by-default ships the whole catalog's schemas (439KB on prod)
      // to count actions.
      const connectors = await client.catalog({ includeSchemas: false });
      return {
        content: content({
          connectors: connectors.map((c) => {
            const summary = accountsSummary(c.slug, c.accounts ?? [], c.default_account ?? null);
            return {
              slug: c.slug,
              name: c.name,
              provider: c.provider,
              status: c.status,
              tools: c.actions.length,
              ...summary,
            };
          }),
        }),
        isError: false,
      };
    }

    case 'discover': {
      const query = typeof args.query === 'string' ? args.query : '';
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const matches = await client.search(query, limit !== undefined ? { limit } : {});
      return {
        content: content({
          matches: matches.map((m) => ({
            tool: m.tool,
            risk: m.risk,
            description: m.description,
          })),
        }),
        isError: false,
      };
    }

    case 'describe': {
      const ref = typeof args.tool === 'string' ? args.tool : '';
      if (!ref.includes('.')) {
        return {
          content: content({
            ok: false,
            error: 'tool must be a "<connector>.<action>" path',
          }),
          isError: true,
        };
      }
      const tool = await client.describe(ref);
      if (!tool) {
        return {
          content: content({
            ok: false,
            error: `unknown tool "${ref}" — run discover to list tools`,
          }),
          isError: true,
        };
      }
      // Same accounts summary as `connectors` — a describe call is often the
      // step right before `call`, so this is where `account` gets decided.
      const accounts = await client.accounts(tool.connector).catch(() => []);
      return {
        content: content({
          tool: tool.tool,
          risk: tool.risk,
          description: tool.description,
          inputSchema: tool.inputSchema,
          // `accounts` comes back default-first (see listEntitledConnectorConnections),
          // so the first entry is what an unnamed call resolves to.
          ...accountsSummary(tool.connector, accounts, accounts[0]?.label ?? null),
        }),
        isError: false,
      };
    }

    case 'call': {
      const connector = typeof args.connector === 'string' ? args.connector : '';
      const action = typeof args.action === 'string' ? args.action : '';
      if (!connector || !action) {
        return {
          content: content({
            ok: false,
            error: 'connector and action are required',
          }),
          isError: true,
        };
      }
      let callArgs = asRecord(args.args);
      if (args.attachment_files !== undefined) {
        const described = await client.describe(`${connector}.${action}`);
        try {
          const slot = described
            ? attachmentSlot(
                described.inputSchema,
                typeof args.attachment_path === 'string' ? args.attachment_path : undefined,
              )
            : null;
          if (!slot) {
            return {
              content: content({
                ok: false,
                error: `${connector}.${action} does not accept attachments: its input schema has no \`attachments\` array. Pass attachment_path to name the array field.`,
              }),
              isError: true,
            };
          }
          const files = await uploadAttachmentFiles(args.attachment_files, client, { connector });
          callArgs = insertAttachmentHandles(
            callArgs,
            slot,
            files.map((file) => attachmentRef(file.attachment_id)),
          );
        } catch (err) {
          return plainToolError(err);
        }
      }
      // Returns the authenticated approval URL immediately when policy gates
      // the call. The server callback resumes the session after a decision.
      let result;
      try {
        result = await callWithApprovalHandoff(client, connector, action, callArgs, {
          account: typeof args.account === 'string' ? args.account : null,
          approvalContext: typeof args.approval_context === 'string' ? args.approval_context : null,
        });
      } catch (err) {
        // A denial is an HTTP 403, so the SDK THROWS it. Left to the JSON-RPC
        // loop it would reach the model as a bare `message` string, dropping
        // `available_accounts`, `hint` and `connect_url` — the only fields
        // that tell the model what to do next. Hand back the API body itself.
        return { content: content(connectorErrorPayload(err)), isError: true };
      }
      return {
        // The result passes through untouched, including the `account` echo
        // that names WHICH identity ran the call — unless it is larger than
        // 16 KB: then it is saved to a file and the model gets the path, the
        // shape, and a preview (OpenCode would truncate it anyway).
        content: content(await spillLargeResult(result, { connector, action })),
        // Pending approval is a successful handoff, not a connector failure.
        isError: result.status !== 'pending_approval' && !result.ok,
      };
    }

    case 'upload_attachment': {
      const connector = typeof args.connector === 'string' ? args.connector.trim() : '';
      if (!connector) {
        return { content: content({ ok: false, error: 'connector is required' }), isError: true };
      }
      try {
        const { connector: _connector, ...file } = args;
        const [uploaded] = await uploadAttachmentFiles([file], client, { connector });
        return {
          content: content({ ok: true, ...uploaded, ref: attachmentRef(uploaded!.attachment_id) }),
          isError: false,
        };
      } catch (err) {
        return { content: content(connectorErrorPayload(err)), isError: true };
      }
    }

    case 'accounts': {
      const connector = typeof args.connector === 'string' ? args.connector : '';
      if (!connector) {
        return {
          content: content({ ok: false, error: 'connector is required' }),
          isError: true,
        };
      }
      const accounts = await client.accounts(connector);
      return {
        content: content({
          ok: true,
          connector,
          accounts,
          ...(accounts.length === 0
            ? {
                note: `Nothing is connected to "${connector}" yet. Call connect to get an authorization link for the human.`,
              }
            : {}),
        }),
        isError: false,
      };
    }

    case 'connect': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      if (!slug)
        return {
          content: content({ ok: false, error: 'slug is required' }),
          isError: true,
        };
      const expires =
        typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined;
      // Default `me`: the human authorizes themselves. `project` is an explicit
      // choice — it creates an account every member can spend — so anything
      // else is refused rather than quietly downgraded.
      const owner: 'me' | 'project' | undefined =
        args.owner === 'me' || args.owner === 'project' ? args.owner : undefined;
      if (args.owner !== undefined && owner === undefined) {
        return {
          content: content({ ok: false, error: 'owner must be "me" or "project"' }),
          isError: true,
        };
      }
      if (args.label !== undefined && typeof args.label !== 'string') {
        return {
          content: content({ ok: false, error: 'label must be a string' }),
          isError: true,
        };
      }
      const label = typeof args.label === 'string' ? args.label.trim() : '';
      try {
        const link = await mintConnectLink({
          slug,
          expiresInMinutes: expires,
          ...(owner ? { owner } : {}),
          ...(label ? { label } : {}),
        });
        return {
          content: content({
            ok: true,
            slug: link.slug,
            owner: owner ?? 'me',
            provider: link.provider,
            app: link.app,
            url: link.url,
            expires_at: link.expires_at,
            connected: link.connected,
            is_no_auth: link.is_no_auth,
            session_id: link.session_id,
            connection_id: link.connection_id,
            request_id: link.request_id,
            instructions: link.url
              ? 'Surface this url to the human now. After they approve it, call finalize_connection with this slug, connection_id, and request_id.'
              : link.connected
                ? 'The connector is connected and ready to call.'
                : 'No authorization URL was returned. Do not call connector actions until connected=true.',
          }),
          isError: false,
        };
      } catch (err) {
        return plainToolError(err);
      }
    }

    case 'finalize_connection': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      if (!slug)
        return {
          content: content({ ok: false, error: 'slug is required' }),
          isError: true,
        };
      try {
        const result = await finalizeConnectorConnection({
          slug,
          ...(typeof args.connection_id === 'string' ? { connectionId: args.connection_id } : {}),
          ...(typeof args.request_id === 'string' ? { requestId: args.request_id } : {}),
        });
        return {
          content: content({
            ok: result.connected,
            slug,
            ...result,
            instructions: result.connected
              ? 'Connection confirmed. Discover or call the connector actions now.'
              : 'Authorization is not complete yet. Ask the human to finish the provider flow, then retry finalize_connection.',
          }),
          isError: false,
        };
      } catch (err) {
        return plainToolError(err);
      }
    }

    case 'request_secret': {
      const names = Array.isArray(args.names)
        ? args.names.filter((n): n is string => typeof n === 'string')
        : [];
      if (names.length === 0)
        return {
          content: content({ ok: false, error: 'names is required' }),
          isError: true,
        };
      const scope =
        args.scope === 'connector' ? 'connector' : args.scope === 'runtime' ? 'runtime' : undefined;
      const expires =
        typeof args.expires_in_minutes === 'number' ? args.expires_in_minutes : undefined;
      try {
        const link = await mintSecretLink({
          names,
          scope,
          expiresInMinutes: expires,
          labels: asRecord(args.labels) as Record<string, string>,
          descriptions: asRecord(args.descriptions) as Record<string, string>,
        });
        return {
          content: content(secretLinkToolPayload(link)),
          isError: false,
        };
      } catch (err) {
        return plainToolError(err);
      }
    }

    case 'set_secret': {
      const values = Object.fromEntries(
        Object.entries(asRecord(args.values)).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
        ),
      );
      if (Object.keys(values).length === 0)
        return { content: content({ ok: false, error: 'values is required' }), isError: true };
      const scope = args.scope === 'connector' ? 'connector' : 'runtime';
      try {
        const saved = await setSecrets({ values, scope });
        return {
          content: content({
            ok: true,
            saved,
            scope,
            instructions:
              scope === 'runtime'
                ? 'Saved. The value is pushed to this session; check the variable in a new shell or run kortix secrets ls. "not granted" there means your agent grant excludes it — tell the human the fix.'
                : 'Saved server-side for the connector gateway. It never appears in the sandbox env.',
          }),
          isError: false,
        };
      } catch (err) {
        return plainToolError(err);
      }
    }

    case 'secret_call': {
      const identifier = typeof args.identifier === 'string' ? args.identifier : '';
      const url = typeof args.url === 'string' ? args.url : '';
      if (!identifier || !url) {
        return {
          content: content({
            ok: false,
            error: 'identifier and url are required',
          }),
          isError: true,
        };
      }
      const method =
        typeof args.method === 'string' && BROKER_METHODS.includes(args.method as BrokerMethod)
          ? (args.method as BrokerMethod)
          : undefined;
      const rawHeaders = asRecord(args.headers);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value;
      }
      try {
        const result = await brokerSecretRequest({
          identifier,
          url,
          method,
          headers,
          ...(typeof args.body === 'string' ? { body: args.body } : {}),
        });
        // Hand back text when the upstream says it is text; base64 otherwise.
        // A model cannot act on a base64 blob, and silently utf8-decoding an
        // image would be worse than labelling it.
        const contentType = result.headers['content-type'] ?? '';
        const isText =
          contentType.startsWith('text/') ||
          contentType.includes('json') ||
          contentType.includes('xml') ||
          contentType.includes('javascript');
        return {
          content: content({
            ok: true,
            status: result.status,
            headers: result.headers,
            ...(isText
              ? {
                  body: Buffer.from(result.body_base64, 'base64').toString('utf8'),
                }
              : { body_base64: result.body_base64 }),
          }),
          // A 4xx/5xx is a real answer from upstream, not a tool failure — the
          // model needs the status and body to decide what to do next.
          isError: false,
        };
      } catch (err) {
        return plainToolError(err);
      }
    }

    case 'add_connector': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      const provider = typeof args.provider === 'string' ? args.provider : '';
      if (!slug || !provider)
        return {
          content: content({
            ok: false,
            error: 'slug and provider are required',
          }),
          isError: true,
        };
      if (provider === 'pipedream' && args.allow_legacy_pipedream !== true) {
        return {
          content: content({
            ok: false,
            error:
              'Pipedream is legacy rollback only. Use provider="composio" for managed SaaS apps. If Composio cannot satisfy the request, stop and ask the human before setting allow_legacy_pipedream=true.',
          }),
          isError: true,
        };
      }
      const draft: Record<string, unknown> = { slug, provider };
      if (provider === 'pipedream') draft.allow_legacy_pipedream = true;
      for (const k of [
        'app',
        'name',
        'url',
        'transport',
        'endpoint',
        'spec',
        'credential',
      ] as const) {
        if (typeof args[k] === 'string') draft[k] = args[k];
      }
      if (typeof args.base_url === 'string') draft.baseUrl = args.base_url;
      try {
        const res = await addConnector(draft);
        return {
          content: content({
            ok: true,
            slug,
            provider,
            applied: true,
            sync: res.sync,
            instructions: `Live now (committed to kortix.yaml on main + synced) — no change request needed. Next: call connect("${slug}") for managed provider authorization, or request_secret for a direct API key.`,
          }),
          isError: false,
        };
      } catch (err) {
        return plainToolError(err);
      }
    }

    case 'remove_connector': {
      const slug = typeof args.slug === 'string' ? args.slug : '';
      if (!slug)
        return {
          content: content({ ok: false, error: 'slug is required' }),
          isError: true,
        };
      try {
        await removeConnector(slug);
        return {
          content: content({ ok: true, slug, removed: true }),
          isError: false,
        };
      } catch (err) {
        return plainToolError(err);
      }
    }

    default:
      return {
        content: content({ ok: false, error: `unknown tool ${name}` }),
        isError: true,
      };
  }
}
/**
 * The `request_secret` result. When the server reports names this session's
 * agent will not receive, the instructions lead with that and the fix: the
 * human fills the form in the same visit, so it is the moment to widen the
 * grant — not after the agent finds no env var and reports a saved value unset.
 */
export function secretLinkToolPayload(link: SecretLinkResult): Record<string, unknown> {
  const base =
    link.scope === 'runtime'
      ? 'Surface this url to the human now. Web: opens a fill-in modal. Slack: tappable link. After submission the runtime value is live in new shells (check the variable itself, or kortix secrets ls — KORTIX_PROJECT_SECRET_NAMES is the session-start list and does not update).'
      : 'Surface this url to the human now. Web: opens a fill-in modal. Slack: tappable link. The connector value remains server-side and never appears in KORTIX_PROJECT_SECRET_NAMES.';
  const withheld = link.withheld ?? [];
  const instructions =
    withheld.length === 0
      ? base
      : `${base} This session will NOT receive ${withheld.map((w) => w.name).join(', ')} even after ` +
        `the value is saved. ${link.withheld_fix ?? ''} Tell the human this fix together with the url.`.replace(
          /\s+/g,
          ' ',
        );
  return {
    ok: true,
    names: link.names,
    scope: link.scope,
    url: link.url,
    expires_at: link.expires_at,
    ...(withheld.length > 0 ? { agent: link.agent, withheld } : {}),
    instructions,
  };
}
