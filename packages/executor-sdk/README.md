# @kortix/executor-sdk

The TypeScript SDK for the **Kortix Executor** — one typed client for every
integration you've configured on a Kortix project (Pipedream / MCP / OpenAPI /
GraphQL / HTTP). It's the third face of the Executor, alongside the
`kortix executor` CLI and the `kortix executor mcp` MCP server: **one core,
three faces.**

Every call runs **server-side** through the Kortix Executor gateway, which
resolves the credential, enforces sharing + policy, runs the call, and audits
it. **No third-party secret ever touches your code.**

```bash
npm i @kortix/executor-sdk
```

```ts
import { createExecutorClient } from '@kortix/executor-sdk';

const executor = createExecutorClient({
  apiUrl: 'https://api.kortix.com',
  token: process.env.KORTIX_TOKEN!, // a Kortix session/user token
  projectId: 'proj_…',              // the project whose connectors you want
});

// Discover → describe → call
const tools = await executor.discover('send a slack message');
const schema = await executor.describe('slack.chat.postMessage');
const result = await executor.call('slack', 'chat.postMessage', {
  channel: '#general',
  text: 'Shipped 🚀',
});
```

## API

- `connectors()` — the connectors this principal can use (slug, provider, status, actions).
- `tools()` / `discover(query, { limit })` — flatten + intent-search the catalog.
- `describe(tool)` — one tool's input schema + risk.
- `call(connector, action, args)` — run a tool through the gateway.

`projectId` is optional: when set, the client uses the project-explicit gateway
routes (which accept a normal user token); when omitted, it uses the legacy flat
routes that derive the project from an in-sandbox session token.

## License

Elastic License 2.0 — see the [repository](https://github.com/kortix-ai/suna).
