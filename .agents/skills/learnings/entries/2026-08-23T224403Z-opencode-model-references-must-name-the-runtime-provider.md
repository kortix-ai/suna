---
recorded: 2026-08-23T22:44:03Z
commit: cd9aa92408
---
# OpenCode model references must name the runtime provider

Found 2026-08-24 while diagnosing prompts that failed after session startup.
The model catalog registered every gateway model under OpenCode provider
`kortix`. Session creation stored nested model IDs such as
`codex/gpt-5.6-sol` without that provider. OpenCode interpreted `codex` as the
provider and returned `ProviderModelNotFoundError`.

**Rules.**
1. Store every gateway-backed OpenCode model as `kortix/<wire-model>`.
2. Preserve nested provider paths. `codex/gpt-5.6-sol` becomes
   `kortix/codex/gpt-5.6-sol`.
3. Strip exactly one `kortix/` prefix before gateway routing.
4. Test managed, BYOK, nested Codex, and already-prefixed references together.

*Incident:* new sessions reached runtime readiness but their first prompt
failed because the stored model named a provider that OpenCode did not expose.
