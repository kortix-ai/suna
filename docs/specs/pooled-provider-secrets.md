# Pooled provider secrets

## Problem

A project stores one shared provider key in its secrets screen. Every project member can use it. A member must enter the same key again in another project. A session cannot choose two keys for the same provider or remove one key without disrupting the others. The reverted provider-connection feature stored access as a user or project binding and placed credential management inside the provider picker.

## Resource and access contract

- An account is the tenant boundary. A secret is an account resource with an immutable `secret_id`, provider, credential kind, label, encrypted value, creator, and lifecycle state. The value never appears in a read response, audit record, log, or browser storage.
- A new provider secret belongs to one project and defaults to `project` access. Every member who can use that project may select it. A manager can restrict access to selected project members with `members` access. Legacy account-wide resources retain member-grant access. Grants permit use, not value disclosure. The creator retains access while they remain eligible in the project.
- This release supports LLM gateway API keys, Gemini keys through Google's OpenAI-compatible endpoint, and ChatGPT OAuth accounts. Runtime variables and connector credentials require separate delivery adapters. Each member can connect more than one ChatGPT account. Each OAuth completion creates a separate account resource and does not replace another login.
- Effective use requires account membership, project membership, matching project scope, the selected access mode, the running agent's grant, and session selection. `members` access also requires a grant. Resolve each at the server boundary. A session token alone does not authorize a secret.
- Background sessions cannot select account resources in this release. They require an explicit service principal grant in a later delivery adapter.
- Existing project secrets keep their current behavior while the flag is off. The rollout does not copy or delete their values. When the flag is on, sessions without a resource selection may continue to use the legacy project secret path. An explicit resource selection never falls back to a legacy or managed credential without the user's separate routing choice.

## Flag

- Key: `pooled_provider_secrets`; label: **Pooled provider secrets**.
- Operator availability and the existing per-project flag both gate resource use in that project. The default is off. Account resource metadata can remain available after a project disables the flag, but disabled projects cannot select or consume it.
- The API enforces the flag for session create, pool updates, and gateway resolution. Disabling the flag stops future gateway resource use.
- Gateway pooling requires `llm_gateway`. Native OpenCode mode keeps its existing project secret behavior.

## Session selection and pool

- A session selects a set of stable secret IDs per provider. An empty explicit selection means no resource secret for that provider. The SDK and UI preserve omitted, empty, and explicit selections distinctly. Without a ChatGPT selection, the caller's newest personal OAuth account is the default. If the caller has none, the legacy project login remains the fallback. Another member's shared account requires explicit selection.
- Model validation uses the prospective selection before session creation and the saved pool for later model changes. Passive validation does not advance the round-robin cursor.
- A selected secret must match the provider, be active, be usable in the session project under its access mode, and be allowed by the running agent. Invalid or unauthorized IDs fail the write atomically. Every gateway request re-evaluates authorization and active state.
- For each new model request, choose a starting key from the eligible pool and visit each selected key at most once. On a pre-output `429`, bound `Retry-After` to 60 seconds, put that key on a shared cooldown, and try the next eligible key. A `429` is not counted against the provider as a whole. If every key is unavailable, return `429` with the earliest retry time.
- Never replay a request once response content has streamed. Do not cycle keys for a provider-wide `5xx`. Other credential errors return without changing resource state.
- Removing a key from one session edits that session's selection. Deleting a secret removes its grants and prunes future selections. An explicit pool with no eligible keys fails closed.
- Read responses show label, provider, grant summary, and cooldown, never values. Gateway request logs must not include secret values.

## User experience

- Put provider key and ChatGPT account management in Models → Providers, beside each provider. Show each named connection as a distinct row with its project or selected-member access and actions. Keep general project secrets in Secrets. Keep `Remove from this session` separate from `Delete secret for everyone`.
- Use the existing member picker for restricted secret access. The access dialog defaults to Everyone in this project for new connections and supports Specific members. Save the access mode and grants in one API request.
- Add provider secret selection to the existing session overrides control. Show the effective choice and distinguish inherited from explicit selection. Support multiple selected keys and a clear reset to inherited behavior.
- Verify both themes, 720 × 480, collapsed sidebar, keyboard focus, scrolling, and the native Electron shell. The UI sends IDs, never values, after initial creation or rotation.

## Verification contract

1. With the flag off, the resource routes reject use and an existing project key still serves a real model request.
2. A manager creates two Anthropic secrets in one project. Both are usable by project members by default. Restrict one to member B. Member A cannot list or select that key, including by guessed ID. Neither member can use a key in another project or account.
3. B selects both keys in a new session. A real gateway request uses one key. A controlled upstream `429` before output uses the next key exactly once. A partial stream is never replayed.
4. Remove one key from the session. The next request uses the remaining key. Delete that key from the account. Read-back shows no grant or usable pool member; no legacy fallback occurs.
5. Restrict the key and revoke B's grant while the session is running. The next gateway call refuses the revoked secret.
6. Rotate one key; the resource ID and session selection stay stable, and the next call uses the new encrypted value.
7. Exercise SDK functions directly, REST flows through HTTP, web controls in Chromium with DOM and request assertions, native Electron, and one real preview session. Run the local and preview gates before requesting merge.

## Implementation sequence

1. Expand the schema with account secret resources, member grants, and session selections. Migrate forward only. Preserve the reverted tables until their data can be audited and retired separately.
2. Add one server authorization resolver for gateway keys. Keep the legacy resolver for flag-off compatibility.
3. Add feature flag and API contracts. Add typed SDK calls with a failing test first. Update public exports, snapshots, and documentation.
4. Add request-level pool selection, shared cooldown, bounded failover, audit records, and explicit failure responses.
5. Build the Models provider-key and session settings UI from existing components. Add browser journeys and desktop checks.
6. Run local HTTP, SDK, browser, and package gates. Open a draft PR with preview, then prove the same objective through a real preview session. Do not merge without explicit approval.

## Takeover review, 2026-09-17

PR #7311 reverted the earlier user/project connection implementation in commit
`79679326abdc6383da8e24e1635846718b29c757`. PR #7319 replaces it with this resource
model. PR #7345 adds project access defaults. Its canonical branch is `pooled-provider-secrets`. Continue that work;
do not restore #7295 or replace Marko's PR without agreeing on the handoff.

The review starts from `ce8a3531a027f9d5617c521bb2bd137f2654abf5`.
The existing preview and CI pass at that commit. They do not prove the following
failure paths, which must be covered before the feature is ready:

1. A session still exposes its configured provider after its last key is revoked
   or deleted. The user can inspect the empty pool and explicitly reset it.
   A failed selection read cannot be mistaken for an inherited selection.
2. A cancelled ChatGPT authorization cannot update a later authorization dialog.
   Grant mutations refresh the authoritative state even after partial failure.
3. Session-bound credentials cannot read or change a sibling session's pool.
   A manager's selection requires grants for both the manager and session owner.
   Background sessions cannot acquire personal account credentials.
4. Browser controls distinguish inherited, selected, empty, unavailable, loading,
   and failed states. Selection limits and pending writes are enforced in the UI.
5. Local HTTP and browser regressions pass. SDK export, type, test, and install
   gates pass. The updated preview proves selection and gateway behavior through
   an actual session. Human OAuth approval remains a separate explicit check.

## ChatGPT BYOS, 2026-09-25

Problem: a project member without `project.secret.write` could not connect
their own ChatGPT subscription. The Add dialog preselected the creator in
`memberIds`, and `POST /oauth/openai/start` treated only an empty member list
as owner-only, so the default request returned 403. Members also had no entry
point outside Customize, and an expired account had no reconnect.

- Owner-only is the same rule on both create paths: `private`, or `members`
  without groups whose member list holds only the caller. It needs project
  read and account membership, nothing more. Every wider share still needs
  `project.secret.write`.
- `resource_id` on start reconnects an existing ChatGPT account in place. Only
  its creator may reconnect it. The request carries no label or sharing. Poll
  success replaces the encrypted login, sets `active`, and clears the cooldown.
  The id, label, access, and session selections stay. A deleted account fails
  the poll; it is never recreated.
- New connections default to **Only you** in the UI. Share options stay visible
  and disabled, with the reason, for callers without secret write.
- The session composer's model picker ends with **Use your ChatGPT
  subscription** (or **Manage ChatGPT accounts** once its models exist). It
  opens the same panel as Models → Providers. Schedule pickers omit it, because
  background sessions cannot use personal accounts. Session overrides open the
  same dialog for ChatGPT instead of linking to Customize.
- Verification: `unit-project-oauth-byos.test.ts`, flow `SEC-POOL-5`, and the
  member journey in `30-pooled-provider-secrets.spec.ts`.

### Failed-turn actions

- A refused ChatGPT turn carries the gateway body: `code`, `requested_model`,
  and `resolved_model` (`provider` is empty for a resolution error). The SDK
  exposes the two model ids on `GatewayErrorDetails`.
- The session error row offers **Reconnect ChatGPT** for
  `provider_reauth_required` and **Connect ChatGPT** for
  `provider_not_connected` on a `codex/*` model, with the flag and the gateway
  on and ChatGPT not disabled. The action opens the ChatGPT accounts dialog.
- The action appears only where the dialog can fix the turn: connect in the
  viewer's own private session without a ChatGPT selection; reconnect there,
  or in a shared session with a selection. A shared session without a
  selection runs on the project login, which the dialog does not manage.
- An agent grant that omits the credential name now returns
  `agent_grant_excludes` instead of `provider_not_connected`, for ChatGPT and
  BYOK pools. A new connection cannot fix it, so no action is offered.
- Verification: `resolve-candidates.test.ts`, `chatgpt-connection-action.test.ts`,
  and the failed-turn journey in `30-pooled-provider-secrets.spec.ts`.

## UI follow-up, 2026-09-18

- One session footer saves every staged provider selection and default reset.
  Switching sections, closing the panel, or crossing a responsive breakpoint preserves drafts for that session.
  Page reload discards unsaved drafts. Session navigation never transfers them.
- Pending saves block dismissal and repeat submissions. A failed provider save
  leaves its draft and subsequent drafts available for retry. Successful provider
  writes remain persisted; this is not a transaction across providers.
- Read-only members can inspect every provider. They cannot edit selections.
- Narrow viewports use horizontal section navigation. Labels wrap instead of
  truncating key names or forcing access summaries outside a row.
- Models load errors include a retry action. Creation errors remain visible in
  the dialog, and pending writes lock the access options.
