# User provider connections

Users currently repeat ChatGPT authorization in each project. A private project secret remains project-scoped.

## Contract

- A user owns up to ten named reusable connections per provider. Credentials remain encrypted on the API.
- Provider adapters describe authentication. Start with ChatGPT device authorization and catalog providers with single API keys.
- Users explicitly enable their connection in each project. The binding grants use under their authenticated gateway identity.
- Session inference uses the launching user recorded in the session token. Another member cannot select that user's connection.
- Personal connections take precedence over project credentials only after explicit binding. Existing project credentials remain compatible.
- Background work uses its existing authenticated principal. No member identity is guessed from project ownership.
- Disconnect deletes the connection and its project bindings. Token refresh updates the same user credential across projects.
- Provider restrictions and existing gateway authorization remain authoritative.
- Management responses expose connection metadata, never credential values.
- No automatic migration or promotion of existing project secrets.

## Personal connection pools

- A project binding selects one owned connection or explicitly enables the user's pool for that provider.
- Pool membership consists only of that user's connections. It never includes another member's credentials.
- A new session selects one pool member uniformly. A database binding keeps that selection stable across requests and API replicas.
- Removing a credential removes its session bindings. A later request can select a remaining pool member. Disconnecting the provider removes every binding.
- Direct requests without a session select a pool member per request.
- Provider authentication errors and usage limits remain visible. Pooling does not retry a rejected request against another account.
- Reauthorizing an existing provider account updates its saved credential instead of adding a duplicate pool member.
- Existing SDK calls keep their behavior. Optional selection fields and connection-specific deletion extend the API.

## Delivery

Continue the implementation from PR #7234 on `codex/user-provider-pooling`, with PR #7295 authored by Ino-Bagaric. Preserve prior authorship. New commits use the configured Git identity. Verify locally and on the PR preview, merge to main, wait for Deploy Dev, and verify both deployed SHAs and the actual API/browser/session behavior.

## Verification

Test cross-user isolation, cross-project reuse, explicit binding, revocation, refresh persistence, and project-credential fallback. Exercise actual HTTP routes, SDK calls, browser controls, and a real preview session before merge.
