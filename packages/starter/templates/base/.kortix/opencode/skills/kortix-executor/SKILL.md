---
name: kortix-executor
description: Use the Kortix Executor to reach external systems from a session. Prefer the `kortix executor` CLI for agent work, use `@kortix/executor-sdk` for durable TypeScript workflows and reusable skills, and treat the `kortix executor mcp` server as an optional compatibility face. Load whenever the user asks the agent to act in an external app/API, inspect available connectors/tools, add/configure a connector, or work with `connectors:` in kortix.yaml.
---

<skill name="kortix-executor">

<overview>
The **Executor** is the one way an agent reaches outside systems. It gives this
session access to configured project integrations (Pipedream, MCP, OpenAPI,
GraphQL, HTTP, `channel` connectors like Slack/email, and connected `computer`
surfaces) without exposing third-party secrets to the sandbox.

The default agent interface is the **`kortix executor` CLI**:

- `kortix executor connectors` - list usable connectors and their tools.
- `kortix executor discover "<intent>"` - search tools by natural-language need.
- `kortix executor describe <connector>.<action>` - inspect one tool schema.
- `kortix executor call <connector> <action> '<json-args>'` - run a tool.
- `kortix executor add/rm/connect` - manage connectors and setup links.

The same Executor core is also available as:

- **`@kortix/executor-sdk`** - TypeScript client for multi-step workflows,
  reusable scripts, skills, agents, and app code.
- **`kortix executor mcp`** - optional stdio MCP server with stable meta-tools.
  Do not assume the MCP tools are present in the current tool list. Use the CLI
  first unless the current runtime explicitly exposes the MCP tools.

Every call goes through the Kortix Executor Gateway. The gateway resolves
credentials server-side, enforces sharing and policy, executes the upstream call,
and audits the result. The sandbox carries a Kortix session/user token such as
`$KORTIX_EXECUTOR_TOKEN`/`$KORTIX_CLI_TOKEN`; it does not carry raw third-party
API keys.
</overview>

<when-to-load>
Load this skill when the user wants to:

- Act in an external app/API - send an email, create a charge, post to Slack,
  create an issue, query an internal API, call a SaaS API, drive a connected
  computer, or inspect an inbox/thread.
- See what integrations/connectors/tools are available.
- Add or configure a connector, request a credential, or work with
  `connectors:` in `kortix.yaml`.
- Build a reusable integration workflow, script, skill, or agent that will call
  external systems repeatedly.

If the task is purely local (editing files, running tests, reading the repo),
you do not need this skill.
</when-to-load>

<cli-first-loop>
Use the CLI for normal agent work. It is JSON-only, pre-authenticated in the
sandbox, and works even when MCP tools are unavailable.

1. List available connectors:

```sh
kortix executor connectors
```

2. Search by intent:

```sh
kortix executor discover "send an email"
```

3. Inspect the exact input schema before calling an unfamiliar tool:

```sh
kortix executor describe email_email_inbox_bjgk.reply_message
```

4. Run the tool:

```sh
kortix executor call email_email_inbox_bjgk reply_message \
  '{"inbox_id":"email-inbox@agentmail.to","message_id":"<message-id>","text":"Reply text"}'
```

`call` takes `<connector> <action> <json-args>`. The `<action>` is the part after
the connector slug in the tool path. For `email_email_inbox_bjgk.reply_message`,
the connector is `email_email_inbox_bjgk` and the action is `reply_message`.

For GraphQL tools, pass selected fields inside `args.__select`, for example:

```sh
kortix executor call internal_graph query.user \
  '{"id":"1","__select":"id name email"}'
```
</cli-first-loop>

<sdk-workflows>
Use `@kortix/executor-sdk` when a workflow is more than a one-off call:

- Several dependent calls, loops, branching, retries, or pagination.
- A workflow you want to save as a script in the repo.
- A reusable skill/agent implementation that should have explicit code, tests,
  and typed inputs.
- Transforming or validating data between Executor calls.
- Persisting state, writing reports, or combining Executor calls with local
  files/database work.

For method signatures, error handling, and a reusable script pattern, read
`references/executor-sdk.md`.

Inside a Kortix sandbox, the CLI is still the fastest way to inspect the
catalog. Once the shape is clear, write a TypeScript script around the SDK:

```ts
import { createExecutorClient } from '@kortix/executor-sdk';

const executor = createExecutorClient({
  apiUrl: process.env.KORTIX_API_URL!,
  token: process.env.KORTIX_CLI_TOKEN ?? process.env.KORTIX_EXECUTOR_TOKEN!,
  projectId: process.env.KORTIX_PROJECT_ID,
});

const matches = await executor.discover('send an email', { limit: 5 });
const tool = await executor.describe(matches[0]!.tool);
if (!tool) throw new Error('email tool not found');

const result = await executor.call('email_email_inbox_bjgk', 'reply_message', {
  inbox_id: 'email-inbox@agentmail.to',
  message_id: '<message-id>',
  text: 'Reply text',
});

if (!result.ok) throw new Error(`Executor call failed: ${result.reason ?? result.status ?? 'unknown'}`);
console.log(JSON.stringify(result, null, 2));
```

For project scripts, prefer `bun run path/to/script.ts`. Keep credentials out of
code; pass only Kortix auth/context from env and let the gateway resolve
third-party secrets.
</sdk-workflows>

<complete-api-access>
Every connector exposes curated named actions. Pipedream connectors also expose
a generic `request` action that proxies to any endpoint of that app's API using
server-side credentials. Use named actions when they fit; use `request` when the
named catalog is missing the endpoint you need.

```sh
kortix executor call github request '{
  "method": "POST",
  "url": "https://api.github.com/repos/kortix-ai/suna/issues/1234/comments",
  "body": { "body": "Review note..." }
}'
```

`request` args: `method`, absolute `url`, optional JSON `body`, and optional
`headers`. The upstream status and response come back through the Executor
envelope. OpenAPI, HTTP, and GraphQL connectors normally expose their whole spec
as named tools, so they usually do not need `request`.
</complete-api-access>

<adding-connectors>
Connectors are defined in `kortix.yaml` and synced into the Executor catalog.
Example:

```yaml
connectors:
  - slug: stripe
    name: Stripe API
    provider: openapi
    spec: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
    auth:
      type: bearer
      # secret value entered through setup link, never in git
```

Providers:

- `pipedream` - app slug + one-click OAuth; includes the generic `request`
  action for full app API access.
- `openapi`, `graphql`, `http` - declared spec/endpoint/base URL plus auth.
- `mcp` - remote MCP server endpoint.
- `channel` - synthesized chat/email connectors such as Slack and AgentMail.
- `computer` - synthesized connected-machine connector.

Use the CLI to add and connect integrations:

```sh
kortix executor add github --provider pipedream --app github
kortix executor connect github
```

Surface the returned setup URL to the user. Never ask the user to paste raw
credentials into chat. For API-key style connectors, use setup-link flows
(`request_secret` via the optional MCP face when available, or the equivalent
Kortix connector/secret setup command when exposed by the CLI).

**Connecting Slack is ONE command — do not use the executor for it.** Slack is
a built-in channel (`slack`/`kortix_slack` are reserved slugs; `executor add`
rejects them). When the user asks to connect Slack, run:

```sh
kortix channels connect
```

On Kortix Cloud that prints a one-click "Add to Slack" install link — surface
the URL to the user and you are done. No Slack app to create, no manifest, no
bot token, no signing secret, no secret-intake link. After the user clicks
Allow, `kortix channels status` shows the connected workspace and the `slack`
CLI + `kortix_slack.*` tools work immediately. Only if `connect` itself reports
that one-click install is unavailable (self-host without the shared Slack app)
does the manual path apply — it walks you through `kortix channels manifest` +
`kortix channels connect --manual`.
</adding-connectors>

<rules>
- Prefer `kortix executor ...` CLI commands for one-off agent actions.
- Use `@kortix/executor-sdk` for durable, multi-step, reusable, or testable
  workflows.
- Do not hand-roll third-party API calls with raw provider tokens. There should
  be no raw third-party tokens in the sandbox.
- If a connector/tool is missing, the connector may be unconfigured, unauthenticated,
  disabled, or not shared with this user. Surface that clearly and use setup-link
  flows when credentials are needed.
- `ok: false`, `denied`, `not_shared`, or `needs_auth` results are real gateway
  policy/auth outcomes. Do not bypass them.
- Be deliberate with `write` and `destructive` tools. Confirm irreversible work.
- Treat MCP tools like `kortix-executor_call` as optional. If the model tries
  one and it is unavailable, switch to the CLI immediately.
</rules>

</skill>
