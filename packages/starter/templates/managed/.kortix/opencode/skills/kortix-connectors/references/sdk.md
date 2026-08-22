# Connector SDK reference

Use `@kortix/sdk` for durable TypeScript workflows that call external systems
through the Kortix Connector gateway. The gateway keeps provider credentials
server-side and enforces connection access and policy.

## Client setup

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: process.env.KORTIX_API_URL!,
  getToken: async () => process.env.KORTIX_CLI_TOKEN ?? null,
});
const connectors = process.env.KORTIX_PROJECT_ID
  ? kortix.project(process.env.KORTIX_PROJECT_ID).connectors
  : kortix.connectors;
```

`backendUrl` must include the `/v1` prefix. Use the project handle when a
project id is available. Use `kortix.connectors` only when a session-scoped
token supplies the project context.

## Methods

- `catalog()` returns the visible Connector catalog.
- `tools()` returns flattened `connector.action` records.
- `search(query, { limit })` searches action names and descriptions.
- `describe(tool)` returns one action schema and risk.
- `call(tool, args)` invokes one Connector action.
- `uploadAttachment(content, input)` uploads an attachment for a later call.

`call` returns `ConnectorCallResult<T>`. HTTP failures throw `ApiError`, which
includes `status` and parsed response details. A policy or connection outcome
can return `ok: false` without throwing.

## Workflow pattern

Inspect the catalog first:

```sh
kortix connectors ls
kortix connectors discover "reply to email"
kortix connectors show email_email_inbox_bjgk.reply_message
```

Then save the workflow as TypeScript:

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: process.env.KORTIX_API_URL!,
  getToken: async () => process.env.KORTIX_CLI_TOKEN ?? null,
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

## Safety rules

- Never put provider credentials in scripts or repository files.
- Confirm write and destructive actions before irreversible effects.
- Treat `needs_auth`, `not_shared`, `denied`, and `ok: false` as real outcomes.
- Test workflows that transform data, branch, retry, or persist output.
