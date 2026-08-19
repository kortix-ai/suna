# @kortix/executor-sdk

Deprecated. Use `@kortix/sdk`.

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: 'https://api.kortix.com/v1',
  getToken: async () => process.env.KORTIX_TOKEN ?? null,
});

const connectors = kortix.project(projectId).connectors;
await connectors.call('gmail.send_email', { to, subject, body });
```

Version `0.12.5` is the final compatibility release. Existing
`ExecutorClient` code continues to work while it migrates to `@kortix/sdk`.
