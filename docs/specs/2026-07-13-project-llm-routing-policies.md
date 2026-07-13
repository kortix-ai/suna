# Project LLM gateway routing policies

## Outcome

Project managers can configure the LLM gateway from Customize without editing
deployment environment variables. The surface owns the project's default and
vision models, one ordered default fallback chain, exact-model overrides, and a
route preview. Runtime execution remains finite and provider-agnostic.

## Product boundary

The first version deliberately supports only:

- one project default model, inheriting the account/platform default when unset;
- one project vision model, inheriting the platform vision model when unset;
- one ordered fallback chain for the resolved default model;
- zero or more exact-model fallback overrides;
- `transient` and `any-error` fallback conditions;
- at most 8 fallback models per chain and 20 exact-model overrides;
- a preview that shows the exact finite route without calling an LLM.

It does not support weights, traffic splitting, regex/provider matching,
recursive policies, arbitrary expressions, time-based rules, or unbounded
retries. A returned route is de-duplicated and bounded again by the gateway.

## Persistence

Add `kortix.project_llm_routing_policies`, keyed by `project_id` with cascade
deletion. It stores:

- nullable `vision_model`;
- nullable `default_fallback_models` (`NULL` means inherit the platform policy;
  an empty array means explicitly disable fallback for the default route);
- nullable `default_fallback_on` paired with the fallback array;
- a validated JSON array of exact-model rules;
- audit timestamps and `updated_by`.

The project default model continues to use the existing
`account_model_preferences(scope='project', scope_key=project_id)` row. The new
whole-policy PUT updates both stores in one database transaction so the UI never
creates split-brain defaults.

## Public contract

`GET /v1/projects/:projectId/gateway/routing-policy` returns:

```ts
{
  version: 1,
  project: {
    defaultModel: string | null,
    visionModel: string | null,
    defaultFallback: { models: string[], fallbackOn: 'transient' | 'any-error' } | null,
    rules: Array<{
      model: string,
      fallbackModels: string[],
      fallbackOn: 'transient' | 'any-error'
    }>
  },
  effective: {
    defaultModel: string,
    defaultModelSource: 'project' | 'account' | 'platform',
    visionModel: string,
    defaultFallback: { models: string[], fallbackOn: 'transient' | 'any-error' }
  },
  platform: {
    defaultModel: string,
    visionModel: string,
    defaultFallback: { models: string[], fallbackOn: 'transient' | 'any-error' }
  }
}
```

`PUT` accepts the `project` object, validates unique exact-model rules and finite
de-duplicated chains, and returns the updated document. `DELETE` clears the
project default and deletes the project routing row. `POST .../preview` accepts
`{ requestedModel, imageInput }` and returns the route plan plus per-model
availability from the real project upstream resolver.

The additive SDK surface is available both as direct functions and as
`kortix.project(id).gateway.routing.{get,set,reset,preview}`. A React Query hook
owns caching and invalidation for the web host.

## Resolution precedence

1. Resolve `auto` through agent -> project -> account -> platform defaults.
2. For an image-bearing `auto` request whose primary lacks image support, use
   the project vision override or platform vision model.
3. If an exact-model project rule matches the chosen primary, use it.
4. Otherwise, for `auto`, use the project default chain when configured.
5. Otherwise use the operator/platform policy.
6. An explicit request with no exact rule remains direct.

The API control plane performs this composition. Gateway packages continue to
treat all model identifiers as opaque strings.

## Authorization and audit

- Read and preview require project read access.
- Save and reset require `project.customize.write`.
- `updated_by` records the authenticated user.
- Invalid, duplicate, looping, or over-limit chains return a typed 400 contract.

## UX

Add a `Routing` tab to Customize -> LLM Gateway using existing Kortix
primitives. It contains:

- Defaults: project default and vision model selectors, each with explicit
  inherited state.
- Default fallback: inherit/custom control, error condition, ordered model rows,
  add/reorder/remove actions.
- Model overrides: disclosure rows with primary model, condition, and ordered
  chain; add/edit/remove through a modal with confirmation on destructive reset.
- Route preview: requested model, image-input toggle, preview button, ordered
  route result, availability labels, and policy/source metadata.
- One Save action with dirty-state protection and clear success/error feedback.

Read-only members see the same resolved policy and preview but no mutation
controls.

## Verification

- RED-first SDK transport/facade/hook tests.
- Pure API policy parsing/composition tests and migration/schema tests.
- Authenticated HTTP CRUD + read-back against the isolated local API/DB.
- Real Chromium assertions for save payload, persisted reload, ordering,
  overrides, reset confirmation, preview request, and visible route.
- Real gateway request proving a project-configured primary success and a
  forced primary failure selecting the configured fallback exactly once.

