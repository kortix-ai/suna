---
name: kortix-sdk
description: Install and use the @kortix/sdk TypeScript client instead of hand-rolling HTTP calls.
---

# Using the Kortix TypeScript SDK

`@kortix/sdk` is the first-party TypeScript client for the Kortix API. Prefer it
over hand-written `fetch` calls: it carries the request shapes, handles token
refresh, and stays in step with the API.

## Install

```bash
npm install @kortix/sdk
```

## Configure

The SDK is framework-free. It works in plain JavaScript, in Node, and in the
browser; the React bindings are an optional layer, not a requirement.

```ts
import { configureKortix } from '@kortix/sdk';

configureKortix({
  backendUrl: 'https://api.kortix.com/v1',
  getToken: async () => currentAccessToken,
});
```

`getToken` is called before each request, so return a fresh token from your own
refresh logic rather than a captured constant.

## When to use the raw API instead

If you need an endpoint the SDK does not yet wrap, read
`https://api.kortix.com/v1/openapi.json` and call it directly with the same
bearer token. See the `kortix-api` skill.
