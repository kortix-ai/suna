# @kortix/sdk

The official Kortix frontend TypeScript SDK. One typed client for the Kortix
agent platform — it unifies **project/session lifecycle** (REST) and **live agent
streaming** (the sandbox/OpenCode runtime) behind a single ergonomic `Session`
handle, so web, mobile, and white-label apps never touch the raw HTTP API or
OpenCode semantics.

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  baseUrl: 'https://api.kortix.ai/v1',
  token: () => getAccessToken(), // string | () => string | Promise<string>
});

// Provision a workspace, then start a session (create + start in one call)
const project = await kortix.projects.provision({ name: 'Acme' });
const session = await kortix.sessions.start({ projectId: project.project_id, prompt: 'Build me a landing page' });

// Stream the agent's work until it goes idle
for await (const snap of session.stream()) {
  render(snap.transcript?.messages ?? []);
}

// Follow up — the agent responds and the stream picks it up
await session.send('Now add a contact form');

// Resume later (e.g. from a sessionId in the URL)
const resumed = await kortix.sessions.get({ projectId, sessionId });
```

### React

```ts
import { useKortixSession } from '@kortix/sdk/react';

const { transcript, status, isStreaming, send } = useKortixSession(kortix, { projectId, sessionId });
```

Works in React DOM and React Native (fetch-based, no DOM APIs).

## Design notes

- **One surface, evolving transport.** Today `stream()` polls the transcript (works
  against any backend). The OpenCode SSE transport can replace it later behind the
  same `AsyncGenerator<SessionSnapshot>` — callers don't change.
- **Tolerant parsing.** Lifecycle responses are normalized (e.g. `start` accepts both
  flat and nested shapes) so the SDK surface stays stable as the API is finalized.
- **Types** mirror the server serializers and the published OpenAPI spec at
  `/v1/openapi.json`; they can be replaced with generated types without surface change.

## Auth

`Authorization: Bearer <token>` — a Supabase JWT (user sessions) or a PAT
(`kortix_pat_…`) for server-side / automation use.
