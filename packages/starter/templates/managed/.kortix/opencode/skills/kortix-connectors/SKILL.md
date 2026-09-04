---
name: kortix-connectors
description: Use Kortix connectors to reach external systems from a session. Use the `kortix connectors` CLI for agent work, `@kortix/sdk` for durable TypeScript workflows, and `kortix connectors mcp` when a stdio MCP server is required. Load this skill to inspect, add, connect, or call external tools without exposing third-party credentials to the sandbox.
---

<skill name="kortix-connectors">

<overview>
A **connector** defines tools against an external system. A **connection** stores
one usable authorization for a connector. A **connector call** invokes one tool.

Use the **`kortix connectors` CLI** for normal agent work:

- `kortix connectors ls` lists connectors and actions.
- `kortix connectors discover "<intent>"` searches visible actions.
- `kortix connectors show <connector>.<action>` shows one input schema and risk.
- `kortix connectors call <connector> <action> '<json>'` invokes one action.
- `kortix connectors add`, `rm`, and `connect` manage connectors and connections.
- `kortix connectors mcp` runs the optional `kortix-connectors` stdio MCP server.

Durable TypeScript workflows use **`@kortix/sdk`** and `createKortix`. Every
call runs through the connector gateway. The
gateway resolves credentials, enforces access and policy, invokes the upstream
system, and records an audit event. The sandbox carries `KORTIX_CLI_TOKEN`; it
does not carry raw third-party credentials.
</overview>

<when-to-load>
Load this skill when the user wants to:

- Act in an external app or API.
- Inspect available connectors, actions, or connected computers.
- Add or configure a connector or connection.
- Request connector credentials without exposing the value.
- Build a repeatable workflow that calls external systems.

Do not load it for work that stays inside the local repository or sandbox.
</when-to-load>

<cli-first-loop>
Use the CLI first. It is pre-authenticated in a session sandbox.

1. List visible connectors:

```sh
kortix connectors ls
```

2. Search by intent:

```sh
kortix connectors discover "send an email"
```

3. Inspect one action before an unfamiliar call:

```sh
kortix connectors show email_email_inbox_bjgk.reply_message
```

4. Call the action:

```sh
kortix connectors call email_email_inbox_bjgk reply_message \
  '{"inbox_id":"email-inbox@agentmail.to","message_id":"<message-id>","text":"Reply text"}'
```

For GraphQL actions, put selected fields in `args.__select`:

```sh
kortix connectors call internal_graph query.user \
  '{"id":"1","__select":"id name email"}'
```
</cli-first-loop>

<sdk-workflows>
Use `@kortix/sdk` for dependent calls, pagination, branching, retries, or
reusable scripts. Read `references/sdk.md` for the full pattern.

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: process.env.KORTIX_API_URL!,
  getToken: async () => process.env.KORTIX_CLI_TOKEN ?? null,
});
const connectors = process.env.KORTIX_PROJECT_ID
  ? kortix.project(process.env.KORTIX_PROJECT_ID).connectors
  : kortix.connectors;

const matches = await connectors.search('send an email', { limit: 5 });
const action = await connectors.describe(matches[0]!.tool);
if (!action) throw new Error('Email action not found');

const result = await connectors.call('email_email_inbox_bjgk.reply_message', {
  inbox_id: 'email-inbox@agentmail.to',
  message_id: '<message-id>',
  text: 'Reply text',
});

if (!result.ok) {
  throw new Error(`Connector call failed: ${result.reason ?? result.status ?? 'unknown'}`);
}
```

Run repository scripts with `bun run path/to/script.ts`. Keep provider
credentials out of code and repository files.
</sdk-workflows>

<adding-connectors>
Connector definitions live in `kortix.yaml`. Connections remain server-side.

```yaml
connectors:
  - slug: stripe
    name: Stripe API
    provider: openapi
    spec: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
    auth:
      type: bearer
```

Use `composio` for managed SaaS apps. Other supported direct providers are
`mcp`, `openapi`, `postman`, `graphql`, and `http`. Add and connect a Composio
toolkit with:

```sh
kortix connectors add github --provider composio --app github --apply
kortix connectors connect github
```

Pipedream exists only for rollback compatibility with already-declared
connectors. Never add a new Pipedream connector automatically. If Composio
cannot satisfy the request, stop, explain the gap, and ask the human before any
explicit `--allow-legacy-pipedream` retry.

Surface the returned connection URL. Never ask the user to paste a credential
into chat. For an API key, use `kortix secrets request NAME --scope connector`.

Slack uses the channel flow. Do not add a Slack connector. Run:

```sh
kortix channels connect
```
</adding-connectors>

<rules>
- Use `kortix connectors` for one-off agent actions.
- Use `@kortix/sdk` for durable or testable workflows.
- Use Composio for every new managed SaaS connector. Never select Pipedream
  unless the human explicitly approves the legacy rollback path.
- Do not use raw provider tokens from the sandbox.
- Treat `denied`, `not_shared`, `needs_auth`, and `ok: false` as real outcomes.
- Confirm irreversible work before a destructive connector call.
- The `kortix-connectors` MCP server is optional. Use the CLI if it is absent.
</rules>

</skill>
