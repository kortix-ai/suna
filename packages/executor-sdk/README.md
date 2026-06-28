# @kortix/executor-sdk

TypeScript client for the **Kortix Executor**. Use it when a connector workflow
deserves code: loops, branching, retries, pagination, validation, persistence,
or a reusable skill/agent/script.

For one-off agent actions, start with the CLI:

```bash
kortix executor connectors
kortix executor discover "send a slack message"
kortix executor describe slack.send_message
kortix executor call slack send_message '{"channel":"#general","text":"Shipped"}'
```

The SDK, the `kortix executor` CLI, and the optional `kortix executor mcp`
server all use the same Executor gateway. Every call runs server-side, where the
gateway resolves credentials, checks sharing and policy, executes the upstream
call, and records an audit event. No third-party secret belongs in your code.

## Install

```bash
npm i @kortix/executor-sdk
```

In a Kortix sandbox this package is already present in the runtime layout used
by the CLI and can be imported by TypeScript scripts.

## Basic Use

```ts
import { createExecutorClient } from '@kortix/executor-sdk';

const executor = createExecutorClient({
  apiUrl: process.env.KORTIX_API_URL!,
  token: process.env.KORTIX_CLI_TOKEN ?? process.env.KORTIX_EXECUTOR_TOKEN!,
  projectId: process.env.KORTIX_PROJECT_ID,
});

const tools = await executor.discover('send a slack message');
const schema = await executor.describe('slack.send_message');
const result = await executor.call('slack', 'send_message', {
  channel: '#general',
  text: 'Shipped',
});

if (!result.ok) {
  throw new Error(`Executor call failed: ${result.reason ?? result.status ?? 'unknown'}`);
}
```

## Multi-Step Workflow Pattern

Use the CLI to inspect the catalog, then save repeatable logic as TypeScript:

```ts
import { createExecutorClient } from '@kortix/executor-sdk';

const executor = createExecutorClient({
  apiUrl: process.env.KORTIX_API_URL!,
  token: process.env.KORTIX_CLI_TOKEN ?? process.env.KORTIX_EXECUTOR_TOKEN!,
  projectId: process.env.KORTIX_PROJECT_ID,
});

const unread = await executor.call<{ messages: Array<{ id: string; from: string; text: string }> }>(
  'email_email_inbox_bjgk',
  'list_messages',
  { inbox_id: 'email-inbox@agentmail.to', label: 'unread', limit: 10 },
);

if (!unread.ok) throw new Error(`list_messages failed: ${unread.reason ?? unread.status}`);

for (const message of unread.data?.messages ?? []) {
  if (!message.text.toLowerCase().includes('invoice')) continue;
  const reply = await executor.call('email_email_inbox_bjgk', 'reply_message', {
    inbox_id: 'email-inbox@agentmail.to',
    message_id: message.id,
    text: 'Received. I will review this and follow up.',
  });
  if (!reply.ok) throw new Error(`reply_message failed for ${message.id}`);
}
```

That shape is the right starting point for reusable skills: keep the natural
language guidance in `SKILL.md`, put non-trivial connector logic in a script,
and have the skill tell the agent when to run that script.

## API

- `connectors()` - connector catalog this principal can use.
- `tools()` - flattened `connector.action` list.
- `discover(query, { limit })` - simple intent search over the visible catalog.
- `describe(tool)` - one tool's schema, risk, and description.
- `call(connector, action, args)` - execute one gateway call.

`projectId` is optional. When set, the client uses project-explicit gateway
routes that accept a normal user token or a session token. When omitted, it uses
the legacy flat routes that derive the project from an in-sandbox session token.

## Runtime Contract

- Use Kortix tokens (`KORTIX_CLI_TOKEN`, `KORTIX_EXECUTOR_TOKEN`, or a user PAT)
  to authenticate to the gateway.
- Do not load provider API keys into scripts. The gateway attaches upstream
  credentials server-side.
- Handle `ok: false` envelopes and `ExecutorError` exceptions explicitly.
- Treat write/destructive actions as real side effects.

## License

Elastic License 2.0 - see the repository.
