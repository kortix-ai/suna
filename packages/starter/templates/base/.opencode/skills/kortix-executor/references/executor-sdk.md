# Executor SDK Reference

Use this reference when writing a durable TypeScript workflow, reusable skill
script, or app integration around the Kortix Executor.

The SDK is `@kortix/executor-sdk`. It uses the same gateway as
`kortix executor` and `kortix executor mcp`: the gateway resolves third-party
credentials server-side, checks sharing and policy, performs the upstream call,
and records audit events. SDK scripts should carry only Kortix auth/context, not
provider API keys.

## Client Setup

```ts
import { createExecutorClient } from '@kortix/executor-sdk';

const executor = createExecutorClient({
  apiUrl: process.env.KORTIX_API_URL!,
  token: process.env.KORTIX_CLI_TOKEN ?? process.env.KORTIX_EXECUTOR_TOKEN!,
  projectId: process.env.KORTIX_PROJECT_ID,
  timeoutMs: 60_000,
});
```

`apiUrl` may be either the API root or `/v1`; the SDK normalizes it. Set
`projectId` when a script should run against a specific linked project using a
normal user token or session token. Omit it only for legacy in-sandbox
session-token routes that derive the project from the token.

## Methods

- `connectors()` returns the visible connector catalog.
- `tools()` returns the flattened `connector.action` list.
- `discover(query, { limit })` searches visible tools by name/description.
- `describe(tool)` returns schema, risk, connector, and action for one tool.
- `call(connector, action, args)` executes one gateway call.
- `request(path, init)` is the lower-level JSON request helper.

`call` returns an envelope like:

```ts
type ExecutorCallResult<T> = {
  ok: boolean;
  data?: T;
  risk?: string;
  status?: string;
  reason?: string;
};
```

HTTP failures throw `ExecutorError` with `status` and parsed `body`. Gateway
policy/auth outcomes may return `ok: false`; handle both.

## Script Pattern

Inspect with the CLI first:

```sh
kortix executor connectors
kortix executor discover "reply to email"
kortix executor describe email_email_inbox_bjgk.reply_message
```

Then save the multi-step workflow as TypeScript:

```ts
import { createExecutorClient } from '@kortix/executor-sdk';

const executor = createExecutorClient({
  apiUrl: process.env.KORTIX_API_URL!,
  token: process.env.KORTIX_CLI_TOKEN ?? process.env.KORTIX_EXECUTOR_TOKEN!,
  projectId: process.env.KORTIX_PROJECT_ID,
});

const matches = await executor.discover('email inbox unread', { limit: 5 });
const inboxTool = matches.find((tool) => tool.tool.includes('list_messages'));
if (!inboxTool) throw new Error('No inbox list tool is available');

const listed = await executor.call<{
  messages: Array<{ id: string; text?: string; from?: string }>;
}>(inboxTool.connector, inboxTool.action, {
  inbox_id: 'email-inbox@agentmail.to',
  label: 'unread',
  limit: 10,
});
if (!listed.ok) throw new Error(`list failed: ${listed.reason ?? listed.status}`);

for (const message of listed.data?.messages ?? []) {
  if (!message.text?.toLowerCase().includes('invoice')) continue;
  const reply = await executor.call('email_email_inbox_bjgk', 'reply_message', {
    inbox_id: 'email-inbox@agentmail.to',
    message_id: message.id,
    text: 'Received. I will review this and follow up.',
  });
  if (!reply.ok) throw new Error(`reply failed for ${message.id}: ${reply.reason ?? reply.status}`);
}
```

Run with:

```sh
bun run path/to/script.ts
```

For reusable skills, keep the intent and instructions in `SKILL.md`, put this
kind of branching/looping logic in a script, and have the skill tell the agent
which script to run and which arguments/environment it expects.

## Safety Rules

- Never put third-party provider credentials in scripts or repo files.
- Confirm write/destructive actions before irreversible side effects.
- Treat `needs_auth`, `not_shared`, `denied`, and `ok: false` as real gateway
  outcomes, not client errors to bypass.
- Add tests around durable scripts when they transform data, branch, retry, or
  persist local output.
