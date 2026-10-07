# Connector SDK reference

Use `@kortix/sdk` for durable TypeScript workflows that call external systems
through the Kortix Connector gateway. The gateway keeps provider credentials
server-side and enforces connection access and policy.

## Client setup

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: process.env.KORTIX_API_URL!,
  getToken: async () => process.env.KORTIX_TOKEN ?? null,
});
const connectors = process.env.KORTIX_PROJECT_ID
  ? kortix.project(process.env.KORTIX_PROJECT_ID).connectors
  : kortix.connectors;
```

`backendUrl` must include the `/v1` prefix. Use the project handle when a
project id is available. Use `kortix.connectors` only when a session-scoped
token supplies the project context.

## Methods

- `catalog()` returns the visible Connector catalog. Each entry's `accounts`
  lists the accounts THIS caller may run it as (default first — the field is
  absent only from a legacy server); `default_account` is the label an
  unnamed call resolves to, or `null`.
- `tools()` returns flattened `connector.action` records.
- `search(query, { limit })` searches action names and descriptions.
- `describe(tool)` returns one action schema and risk.
- `accounts(slug)` returns the accounts a connector can be called as, default
  first — the same list the CLI's `kortix connectors accounts <slug>` prints.
  Call this whenever the workflow needs to know which/how many accounts are
  connected; never infer it from a single call's result.
- `call(tool, args, { account })` invokes one Connector action. A connector
  can hold several accounts (the project's shared one, plus each member's
  own); omit `account` to use the default, or pass a label/id from
  `accounts()`, or the selector words `me` / `project`. The result's
  `account` field says which one actually ran — read it back rather than
  assuming.
- `callAction(slug, action, args, options)` is `call` with types: the same
  request and result, but `args` and `output` come from the file
  `kortix connectors types --out <file>.d.ts` writes. A missing or unknown
  argument is a compile error. Without the file, or for an action not in it,
  `args` is any object and `output` is `unknown`. Managed Composio and
  Pipedream connectors publish no output schema: their `output` stays
  `unknown`.
- `uploadAttachment(content, input)` uploads an attachment for a later call.

`call` returns `ConnectorCallResult<T>`. Every non-2xx answer throws
`ApiError` with `status` and the parsed body in `details`. Only a call held
for approval (HTTP 202, `status: "pending_approval"`) returns `ok: false`
without throwing. A denial throws (403 or 404): `reason: "account_required"`
means several accounts are reachable, none was named, and none is pinned as
the default. Pass `account` explicitly rather than retrying the same call.

Fields of the result beside `data` (the raw upstream answer):

- `output`: the payload without the binding's envelope. Composio
  `data.result`, MCP `structuredContent ?? content`, GraphQL `data.data`,
  otherwise `data`.
- `binding`: `openapi`, `http`, `mcp`, `graphql`, `composio`, `pipedream`, …
- `upstream_status`: the upstream HTTP status, or `null`.
- `upstream_error`: set when the upstream reported a failure inside a 2xx (an
  MCP `isError` result, GraphQL `errors` with no data). Treat it as a failure.

Failures that throw:

- HTTP 429 or 503: the upstream is rate-limited or unavailable.
  `details.retry_after_seconds` (and the `Retry-After` header) says when to
  call again. Back off; never loop without a delay.
- HTTP 500 with `reason` starting `upstream_timeout`: the upstream did not
  answer within 60 seconds. The call may have run. Kortix does not
  deduplicate calls: check the effect before you repeat a write.
- `call` aborts on the client after 30 seconds, before the gateway deadline.
  The aborted call may still run upstream: the same check applies.

## Workflow pattern

Inspect the catalog first:

```sh
kortix connectors ls
kortix connectors discover "reply to email"
kortix connectors show email_email_inbox_bjgk.reply_message
kortix connectors types --out kortix-connectors.d.ts   # types for callAction
```

Then save the workflow as TypeScript:

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: process.env.KORTIX_API_URL!,
  getToken: async () => process.env.KORTIX_TOKEN ?? null,
});
const connectors = process.env.KORTIX_PROJECT_ID
  ? kortix.project(process.env.KORTIX_PROJECT_ID).connectors
  : kortix.connectors;

const matches = await connectors.search('email inbox unread', { limit: 5 });
const listAction = matches.find((item) => item.tool.includes('list_messages'));
if (!listAction) throw new Error('No inbox list action is available');

const listed = await connectors.call<{
  messages: Array<{ id: string; text?: string }>;
}>(listAction.tool, {
  inbox_id: 'email-inbox@agentmail.to',
  label: 'unread',
  limit: 10,
});

if (!listed.ok) {
  throw new Error(`List failed: ${listed.reason ?? listed.status ?? 'unknown'}`);
}

for (const message of listed.data?.messages ?? []) {
  if (!message.text?.toLowerCase().includes('invoice')) continue;
  const reply = await connectors.call('email_email_inbox_bjgk.reply_message', {
    inbox_id: 'email-inbox@agentmail.to',
    message_id: message.id,
    text: 'Received. I will review this and follow up.',
  });
  if (!reply.ok) throw new Error(`Reply failed for ${message.id}`);
}
```

## Calling from an App, a backend, or a script

The call is the same as above. Only `createKortix` changes, and the
credential decides which accounts the call reaches. The public docs page is
`/docs/sdk/connectors`.

**App, browser.** Set the App to `kortix apps access <app> --viewer api`.
The gate answers `/_kortix/api/v1/*` on the App's own origin, so no CORS rule
is involved:

```ts
import { createKortix, kortixAppViewerToken } from '@kortix/sdk';

const kortix = createKortix({ backendUrl: '/_kortix/api/v1', getToken: kortixAppViewerToken() });
const deals = await kortix.project(projectId).connectors.call('crm.list_deals', { stage: 'won' });
```

The call runs as the viewer: shared accounts they may use and their own
private accounts. With `--viewer identity` it answers `403
insufficient_scope`. The viewer token reaches every project the viewer can
read: always pass the App's own `projectId`.

**App, server.** One client per request, never a stored token:

```ts
import { createAppViewerKortix } from '@kortix/sdk/server';

const kortix = await createAppViewerKortix(request, { backendUrl: 'https://api.kortix.com/v1' });
```

**Convex action, or an App job with no viewer.** Kortix does not mint a
credential for App or backend code. A person creates a service account:

```sh
kortix tokens service-accounts new crm-sync --description "Convex CRM sync"   # bearer prints once
kortix access grant --service-account <id> --role member --project <project-id>
npx convex env set KORTIX_API_URL https://api.kortix.com/v1
npx convex env set KORTIX_PROJECT_ID <project-id>
npx convex env set KORTIX_API_KEY <kortix_sa_…>
```

An agent session cannot run the first two commands. Ask the person, then
write the action:

```ts
'use node';
import { internalAction } from './_generated/server';
import { createKortix } from '@kortix/sdk';

export const syncDeals = internalAction({
  args: {},
  handler: async () => {
    const kortix = createKortix({
      backendUrl: process.env.KORTIX_API_URL!,
      getToken: async () => process.env.KORTIX_API_KEY!,
    });
    const result = await kortix
      .project(process.env.KORTIX_PROJECT_ID!)
      .connectors.call('crm.list_deals', { stage: 'won' });
    return result.output;
  },
});
```

- Use a `'use node'` action. The SDK is not verified in the default Convex
  runtime.
- The service account reaches only shared accounts nobody narrowed. A
  private or narrowed account answers `403 connector_not_connected`.
- Without a project role, every call answers `403`.
- Anyone with the deployment admin key reads the bearer from the Convex env.
- `kortix tokens service-accounts disable <id>` revokes it: calls answer `401`.

For a server App job, store the bearer as a project secret and map it in
`kortix.yaml` (`apps.<slug>.secrets: { CRM_SYNC_TOKEN: <secret-name> }`).
Names that start with `KORTIX_` are reserved and fail validation.

**External program or CI.** A personal access token acts as its owner,
private accounts included. Bind it to one project:
`kortix tokens new crm-export --project <project-id> --expires 90d`.

## Safety rules

- Never put provider credentials in scripts or repository files.
- Confirm write and destructive actions before irreversible effects.
- Treat `needs_auth`, `not_shared`, `denied`, `account_required`, and
  `ok: false` as real outcomes.
- A connector is not an account — check `accounts()` before assuming a
  connector has exactly one, and pass `account` explicitly in a script that
  must always run against the same one.
- Test workflows that transform data, branch, retry, or persist output.
