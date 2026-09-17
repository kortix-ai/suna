# Provider and model control

## Problem

The current model switches only change picker visibility. A direct request still runs a hidden model. Projects cannot disable a provider while retaining its credentials.

## Contract

- Controls belong to the project. Managers can change them; readers can inspect them.
- Disable Kortix Managed Models or any catalog provider, including Codex and custom providers.
- Provider disable takes precedence over individual model preferences, including models added later.
- Disable individual models without changing other providers or models.
- Preserve credentials and per-model preferences when a provider is disabled.
- Reject explicit requests for disabled targets before resolving credentials or calling an upstream.
- Do not use a disabled managed model as a BYOK fallback.
- Require a different project default before disabling its model or provider.
- Existing display-only overrides retain their behavior. A new explicit disable is a separate policy.
- Provider/model controls cover requests through the Kortix gateway. Native runtimes that bypass the gateway do not claim enforcement.

## Implementation

Store explicit disabled provider/model IDs in `projects.metadata.model_access`. Use the existing JSON metadata column; no migration is required. Serialize changes with a project row lock. Expose authenticated GET/PUT `/projects/:projectId/model-access` through `@kortix/sdk`. Each PUT changes one target, so simultaneous edits cannot replace unrelated settings.

Compose the policy into the picker and upstream resolver. Keep disabled models in management responses so they remain discoverable and can be re-enabled. Refresh both SDK picker caches after a write. Show provider controls beside credential configuration and model controls in Models.

## Verification

1. Unit tests: normalization, provider precedence, re-enable, future models, legacy visibility independence.
2. SDK tests: route, payload, response, authentication, rejected writes, cache invalidation.
3. REST flow: permission denial, persistence, default conflict, provider/model changes, metadata and credential preservation, direct inference rejection, reset/re-enable.
4. Browser: real controls, PUT payload and response, visible state after reload, picker exclusion and re-enable, read-only state.
5. Real session: allowed model works; disabled model/provider is rejected; managed fallback remains blocked.
6. Gates: API checks, SDK typecheck/test/install smoke, frontend typecheck/lint, brand audit, root tests.
7. Draft PR and preview verification. Merge and dev deployment require explicit merge authorization.
