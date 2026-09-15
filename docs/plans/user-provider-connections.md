# User provider connections

Users currently repeat ChatGPT authorization in each project. A private project secret remains project-scoped.

## Contract

- A user owns one reusable connection per provider. Credentials remain encrypted on the API.
- Provider adapters describe authentication. Start with ChatGPT device authorization and catalog providers with single API keys.
- Users explicitly enable their connection in each project. The binding grants use under their authenticated gateway identity.
- Session inference uses the launching user recorded in the session token. Another member cannot select that user's connection.
- Personal connections take precedence over project credentials only after explicit binding. Existing project credentials remain compatible.
- Background work uses its existing authenticated principal. No member identity is guessed from project ownership.
- Disconnect deletes the connection and its project bindings. Token refresh updates the same user credential across projects.
- Provider restrictions and existing gateway authorization remain authoritative.
- Management responses expose connection metadata, never credential values.
- No automatic migration or promotion of existing project secrets.

## Verification

Test cross-user isolation, cross-project reuse, explicit binding, revocation, refresh persistence, and project-credential fallback. Exercise actual HTTP routes, SDK calls, browser controls, and a real preview session before merge.
