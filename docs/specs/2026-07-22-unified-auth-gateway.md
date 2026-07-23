# Unified auth gateway — service boundary, provider registry, and the two-door UX

Status: proposed execution spec, for owner decision on §11
Date: 2026-07-22
Scope: `acp-harness-runtime-v2` worktree (branch `acp-harness-runtime-v2`), read-only pass —
no code changed by this document. Three other agents are actively writing on this branch
(uncommitted changes observed in `apps/api/src/experimental/features.ts`,
`apps/api/src/projects/lib/agent-config-v2.ts`, `apps/api/src/projects/lib/composer-capabilities.ts`,
`apps/api/src/projects/routes/agent-config.ts`, `apps/api/src/snapshots/dockerfile-layer.ts`,
`apps/api/src/snapshots/version-keys.ts`, `apps/web/.../connect-model-modal.tsx`,
`packages/api-contract/src/index.ts`, `packages/sdk/src/acp/reduce.ts`,
`packages/shared/src/harnesses.ts`, `packages/shared/src/runtime-versions.*`,
`packages/starter/.../embedded.generated.json`) — this document does not touch those files
and flags every dependency on their in-flight shape explicitly.

Author: Claude (planning agent), for Marko

## 0. The owner's mandate, restated precisely

> "Hardcore refactor. Centralize ALL the authorization — everything — in one service, in our
> LLM gateway service, and whatever way we store it, and then we pass it wherever needed."

Plus the UX reference (Pi's CLI): exactly two doors — **"Sign in with an account"**
(subscription/OAuth: Anthropic, OpenAI Codex, GitHub Copilot, xAI, …) and **"Sign in with an
API key"** (the long provider list). Browser OAuth with a redirect/callback completion page as
the default flow shape, device-code for headless, paste-the-redirect-URL as fallback.

Two live additions from the owner, folded in throughout (marked `[owner-addendum]` at point of
use):

1. **Pi (`github.com/earendil-works/pi`) is the implementation reference.** §3 reads its actual
   auth code in depth and cites files/paths. We steal the *shapes* (registry schema, flow state
   machines, fallback handling) — storage/custody stays ours.
2. **Browserless web, real-callback CLI.** The real localhost OAuth callback server is
   **CLI-only** (full parity with pi/codex's own CLIs). The **web app never runs a fake
   localhost dance** — it uses device-code where the provider offers it (Codex, GitHub Copilot,
   xAI), and paste-the-code/redirect-URL where it doesn't (Anthropic — where the sanctioned
   `setup-token` paste flow already *is* that path). The one-click claude.ai OAuth stays an
   explicitly-gated, undecided config flip with the ToS risk stated plainly, per the existing
   custody finding.

---

## 1. Audit — what already exists, what's mid-flight, what this document actually adds

This matters more than usual here: the owner's mandate reads as "build a credential system from
nothing," but a large fraction of "centralize authorization in the gateway" **already shipped on
this branch**, verified by direct read of the live files, not inferred from the prerequisite
docs (which were themselves written earlier today and are already partly stale — see 1.2).

### 1.1 Already built and correct — build on this, do not re-derive it

- **The capability matrix (concept 1.2 of `2026-07-21-model-resolution-refactor-plan.md`) is
  live**: `packages/shared/src/harnesses.ts` — `HARNESSES[harness].authKinds`
  (`HarnessAuthKind` = `managed_gateway | claude_subscription | anthropic_api_key |
  codex_subscription | openai_api_key | openai_compatible | anthropic_compatible |
  native_config`), plus **two functions this spec builds directly on**:
  - `compatibleHarnessesFor(kind): HarnessId[]` (harnesses.ts:162-164) — the derived inverse,
    already the single source both web and CLI must read for "which harnesses does this
    credential unlock."
  - `CREDENTIAL_CUSTODY: Record<HarnessAuthKind, CredentialCustody>` (harnesses.ts:191-200) —
    **already encodes the exact custody table this spec was asked to define**:
    `claude_subscription: 'direct-only'`, `native_config: 'direct-only'`, everything else
    `'relay-eligible'`. This is not a proposal in this document — it is shipped, dependency-free,
    browser/RN-safe code today.
- **The availability resolver (concept 1.4) is live**: `apps/api/src/llm-gateway/resolution/
  harness-models.ts` — `resolveHarnessModels()`, a closed `ready | no_credential | expired |
  healthy_but_no_models` state union, `upstreamKindForCredential()`, `assertRelayEligible()`
  (throws `CredentialCustodyViolationError` — the exact "refuses, does not silently degrade"
  enforcement the model-resolution-refactor-plan specified), `isCredentialConfigured()`. This
  file already has a test suite (`harness-models.test.ts`). **This is the resolver every
  consumer of this spec's registry must call — this document does not propose a second one.**
- **Codex's OAuth credential resolution is live and correct**: `apps/api/src/llm-gateway/
  credentials/codex.ts` (122 lines, read in full) — `resolveCodexCredential(projectId, userId,
  fetchImpl?)`, shared-vs-personal row precedence (`loadCodexRow`, lines 30-45, matching
  `secrets.ts`'s general precedence rule), single-flight refresh (`refreshSingleFlight`, lines
  83-94, an in-memory `Map` collapsing concurrent refreshes), grace-period-on-refresh-failure
  (lines 107-117), refresh-and-persist as a read-modify-write on the **same** `project_secrets`
  row (lines 49-81, `encryptProjectSecret`/`decryptProjectSecret` imported from `projects/
  secrets.ts` — confirms Store 1 is genuinely one store, not two).
- **A real device-code OAuth flow already exists end to end for Codex**: `apps/api/src/
  projects/routes/r3.ts:600-940` (read in full) — `POST /:projectId/oauth/:provider/start`
  (kicks a device challenge, seals its state into an **opaque encrypted handle** returned to the
  client — `encryptProjectSecret(projectId, JSON.stringify({d, u, s, uid, e}))`, r3.ts:768-777 —
  **no server-side flow table**, any replica can serve any poll because the state round-trips
  through the client, ciphertext-authenticated so it can't be forged or read cross-project), `POST
  /:projectId/oauth/:provider/poll` (any replica decrypts the handle, polls OpenAI, persists via
  `writeCodexAuthSecret` on success, r3.ts:791-856), `GET /:projectId/oauth` (list, r3.ts:860-906),
  `DELETE /:projectId/oauth/:provider` (r3.ts:908-940). **This exact "opaque encrypted
  client-held handle instead of a server flow table" pattern is the one this spec generalizes
  to every OAuth provider** (§6.3) — it is a genuinely good pattern, not something to replace.
  The registry gap is `OAUTH_PROVIDERS: Record<string, {secretName}> = {openai: {...}}`
  (r3.ts:615-617) — **hardcoded to exactly one entry**, which is precisely the "route sprawl"
  the mandate's kill-list item names.
- **A working CLI OAuth client already exists**: `apps/cli/src/commands/providers.ts` (read in
  full, 496 lines) — `providersLogin()` (lines 222-309) drives the same start/poll routes with a
  plain terminal spinner-and-poll loop, opens the verification URL via `openInBrowser` (no local
  callback server — it's device-code, which needs none). `providers set/rm/ls` cover the API-key
  door already, reading provider→env-var mappings from `@kortix/llm-catalog`'s
  `primaryAuthEnvVars` (line 90) — **the exact "CLI and web read the same registry" property
  already holds for the API-key half**; it does not yet hold for the OAuth half because
  `OAUTH_PROVIDERS` is duplicated (`r3.ts:615-617` server-side, `providers.ts:110` client-side,
  independently hand-maintained — confirmed by reading both, this is a live drift risk today,
  not hypothetical).
- **Custody enforcement is real, not aspirational**: `apps/kortix-sandbox-agent-server/src/acp/
  harness-registry.ts`'s `isolateHarnessAuthEnv` strips every provider-credential env var and
  re-admits only the active kind's, per harness, pinned by
  `harness-registry.conformance.test.ts:78-352` (per the prerequisite docs, re-confirmed present
  by grep in this pass).
- **Storage is genuinely already unified**: `project_secrets` (`apps/api/src/projects/
  secrets.ts`, read in full) is the one encrypted table for every credential kind — API key,
  Claude subscription token, Codex OAuth bundle. AES-256-GCM, per-project HKDF-derived key
  (`projectSecretKey`, secrets.ts:49-61), `scope: 'runtime' | 'connector'`, `ownerUserId: null`
  (shared) vs a user id (personal override, wins only while `active`,
  `listResolvedProjectSecrets`, secrets.ts:194-231). **This document does not propose a new
  store** — see §4's explicit "no" on that question.

### 1.2 Correction to the prerequisite docs — Pi's `ownsDefaultModel` question is already resolved

`2026-07-21-gateway-universal-transport-plan.md` §7 and `2026-07-21-model-resolution-refactor-
plan.md` §9 both flag "does Pi actually own its default model, or is `harnesses.ts`'s
`ownsDefaultModel: true` aspirational" as an open risk blocking Phase 2 for Pi. **Resolved on
this branch since those docs were written**: `harnesses.ts:122-138`, Pi's descriptor now reads
`ownsDefaultModel: false` with a code comment dated 2026-07-21 explaining exactly this
correction ("Pi is gateway/catalog-driven, NOT harness-owned... Known fallout: `apps/cli/src/
commands/agents.ts`'s `ownsDefaultModelHarness` guard... still assert the old `true` value —
stale, tracked separately"). `harness-models.ts` is built against the corrected value. This
spec treats Pi identically to OpenCode throughout (catalog-driven, `managed_gateway` +
`anthropic_api_key` + `openai_api_key` + `openai_compatible` eligible) — the open item is only
the CLI's stale `ownsDefaultModelHarness` guard, noted in the kill-list (§10).

### 1.3 What's genuinely missing — the actual scope of this document

Given §1.1, "centralize authorization in the gateway" is **already ~60% true** for the
credential-health/capability-matrix/availability-resolution layer. What's missing, precisely:

1. **No provider registry.** `HARNESSES[*].authKinds` answers "which auth *kinds* does a harness
   accept" — a coarse 8-value enum. It does not answer "which human-facing *providers*
   (Anthropic, OpenAI, GitHub Copilot, xAI, Google, Groq, …) exist, what flows each supports,
   what their OAuth client config is, or how to render the two-door picker." That registry does
   not exist anywhere in the tree today (confirmed by grep for `PROVIDER_REGISTRY`,
   `AuthProvider`, `authProviders` — zero hits outside `PROVIDER_CATALOG_ID`/`PROVIDER_ENV_VARS`
   in the CLI, which only covers the API-key door, and `OAUTH_PROVIDERS`'s one-entry stub in
   `r3.ts`).
2. **No OAuth infrastructure beyond Codex's one hardcoded device flow.** No browser-OAuth/PKCE
   code anywhere in `apps/api` or `apps/web` (grepped for `code_verifier`, `code_challenge`,
   `PKCE` — zero hits outside this document and the prerequisite specs' prose). No redirect
   callback route, no completion page, no CLI local callback server.
3. **No Claude credential module.** `credentials/codex.ts` has no sibling `credentials/
   claude.ts` — `claude_subscription`'s health is still presence-only
   (`isCredentialConfigured`'s `claude_subscription` branch, harness-models.ts:156-157:
   `Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim())`, no expiry/liveness check).
4. **No generic API-key liveness check.** Every non-Codex, non-Claude kind is presence-only in
   `isCredentialConfigured` too (`anthropic_api_key`, `openai_api_key`, etc. — all
   `Boolean(env.X?.trim())`).
5. **No unified UI mount for the two-door picker.** `connect-model-modal.tsx` renders
   "Subscriptions" then "API keys & endpoints" as two sections in one flow (closer to Pi's model
   than it looks), but it is driven by the 8-entry `CONNECTIONS` table in `composer-
   capabilities.ts`, not a registry the CLI also reads — the CLI's help text and web's modal are
   two independently-maintained descriptions of the same provider list today (verified: `CLI
   HELP` in `providers.ts:22-62` hardcodes provider names/env-vars in prose; web's
   `connect-model-modal.tsx` reads its own `CONNECTIONS`/`CATALOG` data — no shared registry
   backs both).

**This document's actual job**: define the provider registry (item 1) and the OAuth
infrastructure (item 2) as new code in `apps/api/src/llm-gateway/auth/**`, wire items 3-4 as
credential-health extensions consumed by the *already-built* `harness-models.ts` (not a rewrite
of it), and make web/CLI/Models-page render off the registry (item 5) instead of their own
hand-maintained lists. Nothing in §1.1 is being replaced.

---

## 2. Reading Pi's implementation — the reference, in depth

Cloned `github.com/earendil-works/pi` (public, `earendil-works/pi`) into the scratchpad and read
its auth stack directly. This is not a survey — every claim below is a specific file read in
full or in the relevant part.

### 2.1 The provider/credential type contract — `packages/ai/src/auth/types.ts`

The whole registry rests on one pair of interfaces (types.ts:161-221):

```ts
interface ApiKeyAuth {
  name: string;                      // display name
  login?(interaction): Promise<ApiKeyCredential>;   // absent = ambient-only (env/AWS/ADC)
  check?(input): Promise<AuthCheck | undefined>;     // side-effect-free liveness probe
  resolve(input): Promise<AuthResult | undefined>;   // credential+ambient → request auth
}

interface OAuthAuth {
  name: string;
  loginLabel?: string;               // e.g. "Sign in with SuperGrok or X Premium"
  login(interaction): Promise<OAuthCredential>;
  refresh(credential, signal?): Promise<OAuthCredential>;   // network call, run under a lock
  toAuth(credential): Promise<ModelAuth>;                    // credential → {apiKey, headers, baseUrl}
}

interface ProviderAuth {
  apiKey?: ApiKeyAuth;
  oauth?: OAuthAuth;                 // presence of BOTH = the provider offers both doors
}
```

**This is the two-door taxonomy in code, not prose**: a `Provider` (`packages/ai/src/providers/
*.ts`, one file per provider, e.g. `openai-codex.ts`) attaches a `ProviderAuth` with `apiKey`
and/or `oauth` populated. `openai-codex.ts:9-16` — `auth: { oauth: lazyOAuth({ name: "OpenAI
(ChatGPT Plus/Pro)", load: loadOpenAICodexOAuth }) }` — Codex offers OAuth only, no API-key door
(matches Kortix's product framing exactly: subscription-only providers don't get a redundant
API-key row). Providers with both doors (Anthropic, xAI, GitHub Copilot in some configs) declare
both fields; the UI (`AuthSelectorProvider`, §2.4) renders one row per **provider**, not per
door — the mode is a property read off which fields are populated, echoed by
`formatAuthSelectorProviderType(authType)` returning `"subscription"` vs `"API key"`.

**`AuthInteraction`** (types.ts:150-155) is the abstraction that makes one `login()`
implementation work across surfaces: `{ prompt(AuthPrompt): Promise<string>; notify(AuthEvent):
void; signal?: AbortSignal }`. `AuthPrompt` (types.ts:119-124) is a closed union — `text | secret
| select | manual_code` — and `AuthEvent` (types.ts:131-141) is `info | auth_url | device_code |
progress`. **A single provider's `login()` function never knows if it's running in a TUI, a
web server, or a headless script — it only calls `interaction.notify({type:'auth_url', url,
instructions})` or `interaction.prompt({type:'manual_code', ...})` and the calling surface
decides how to render that.** This is the single most portable idea in Pi's design and directly
answers "how do CLI and web share one flow implementation without duplicating OAuth logic twice"
— see §6.1 for how this maps onto Kortix's server-authoritative (not client-driven) shape.

### 2.2 Anthropic OAuth — `packages/ai/src/auth/oauth/anthropic.ts` (full read)

The exact reference the owner named:

- `CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")` → base64-decodes to
  `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (line 29, confirmed matches the owner's cited id
  byte-for-byte).
- `AUTHORIZE_URL = "https://claude.ai/oauth/authorize"` (line 30).
- `TOKEN_URL = "https://platform.claude.com/v1/oauth/token"` (line 31) — note: **token exchange
  goes to `platform.claude.com`, not `claude.ai`** — the authorize/token hosts differ.
- `CALLBACK_PORT = 53692`, `REDIRECT_URI = http://localhost:53692/callback` (lines 33-35).
- `SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code
  user:mcp_servers user:file_upload"` (lines 36-37).
- PKCE via `generatePKCE()` (`pkce.ts`, full read, §2.5) — `S256` challenge method.
- **The exact dual-path pattern the owner asked for**: `startCallbackServer(expectedState)`
  (lines 99-168) opens a real Node `http.createServer` on `127.0.0.1:53692`, races against
  `interaction.prompt({type:'manual_code', message:'Complete login in your browser, or paste the
  authorization code / redirect URL here:', signal: manualAbort.signal})` (lines 256-270) —
  **whichever settles first wins**, the other is cancelled (`server.cancelWait()` /
  `manualAbort.abort()`). `parseAuthorizationInput` (lines 52-80) accepts three shapes: a full
  URL (extracts `code`/`state` query params), a `code#state` fragment, or a bare `code=...`
  query string — tolerant paste parsing, not a strict single format.
- **The completion page text, verbatim** (line 145): `oauthSuccessHtml("Anthropic
  authentication completed. You can close this window.")` — **this is the exact copy the owner's
  brief already specified**, confirming it's lifted from this reference, not invented
  independently.
- **Refresh** (`refreshAnthropicToken`, lines 308-340): `grant_type: refresh_token` against the
  same `TOKEN_URL`, expiry stored as `Date.now() + expires_in*1000 - 5*60*1000` (a 5-minute
  safety skew baked into the stored value itself, not applied at read time) — the pattern §5.2
  reuses for the new `credentials/claude.ts` module, **if/when** Anthropic's own OAuth token
  format (as opposed to `setup-token`'s output) is ever adopted (gated, §11 open decision #1).

### 2.3 OpenAI Codex OAuth — `packages/ai/src/auth/oauth/openai-codex.ts` (full read)

- `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`, `AUTH_BASE_URL = "https://auth.openai.com"`,
  `AUTHORIZE_URL/TOKEN_URL` under it (lines 26-29).
- `REDIRECT_URI = "http://localhost:1455/auth/callback"` (line 30) — **confirms the owner's
  cited `localhost:1455` exactly**, and confirms Anthropic's parity doc's D-item ("Codex's
  registered redirect is localhost, so web needs a fallback") is architecturally identical to
  Anthropic's own localhost-bound redirect — **neither provider's browser-OAuth redirect is
  reachable from a hosted web origin at all**; both are CLI-shaped by construction, which is
  exactly why the owner's browserless-web decision is correct on the merits, not just a product
  preference.
- **Two full flows, offered as an explicit menu** (lines 510-531): `login()` prompts
  `{type:'select', message:'Select OpenAI Codex login method:', options:[{id:'browser',
  label:'Browser login (default)'}, {id:'device_code', label:'Device code login (headless)'}]}`
  — browser-first, device-code as the explicit headless alternative. Browser path
  (`loginOpenAICodex`, lines 444-501) is the identical local-server-race-vs-manual-paste shape as
  Anthropic's. Device path (`loginOpenAICodexDeviceCode`, lines 426-442) calls
  `startOpenAICodexDeviceAuth` → `POST {AUTH_BASE_URL}/api/accounts/deviceauth/usercode` →
  `pollOpenAICodexDeviceAuth` (uses the shared `pollOAuthDeviceCodeFlow` poller, §2.6) →
  exchanges via a **different** redirect URI, `DEVICE_REDIRECT_URI =
  "{AUTH_BASE_URL}/deviceauth/callback"` (line 34) — device and browser flows use different
  token-exchange redirect URIs even though both ultimately call the same `TOKEN_URL`.
- `getAccountId` (lines 395-400) decodes the JWT access token's
  `https://api.openai.com/auth.chatgpt_account_id` claim — matches Kortix's own
  `CODEX_AUTH_JSON` shape needing an `accountId` field (`codex-core.ts`'s `CodexCredential`,
  confirmed by `codex.ts:121`'s `{access, accountId}` return shape).

### 2.4 GitHub Copilot and xAI — both pure RFC 8628 device-code, no browser variant at all

`github-copilot.ts` (full read) — `startDeviceFlow` → `POST https://{domain}/login/device/code`
→ `pollForGitHubAccessToken` (uses the shared poller) → **a second exchange step Kortix must
replicate**: the GitHub access token is not directly usable — it must be exchanged for a
Copilot-specific token via `GET https://api.{domain}/copilot_internal/v2/token`
(`refreshGitHubCopilotAccessToken`, lines 244-277), whose response embeds a `proxy-ep=` field
that `getBaseUrlFromToken` (lines 68-75) parses into the actual per-account API base URL — **the
base URL is credential-derived, not static**, a real difference from every other provider in
this matrix. Post-login, `enableAllGitHubCopilotModels` (lines 320-327) POSTs a per-model
`{state:'enabled'}` policy-acceptance call for every known Copilot model — **a required
post-auth step with no equivalent in any other provider here**, flagged for whoever implements
the Copilot adapter (§7).

`xai.ts` (full read) — pure `pollOAuthDeviceCodeFlow` against `https://auth.x.ai/oauth2/device/
code` / `/token`, `CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"`, no browser-OAuth path
exists in Pi's code at all for xAI. **Confirms xAI needs zero web-vs-CLI special-casing** — it
is device-code-only on every surface by construction, the simplest row in the whole matrix.

### 2.5 PKCE — `packages/ai/src/auth/oauth/pkce.ts` (full read, 35 lines)

Pure Web Crypto, works identically in Node 20+/Bun and browsers: 32 random bytes → base64url
verifier; SHA-256 digest of the verifier (as ASCII bytes, not the raw bytes) → base64url
challenge; `S256` method. No dependency, ports directly.

### 2.6 The shared device-code poller — `packages/ai/src/auth/oauth/device-code.ts` (full read)

One generic `pollOAuthDeviceCodeFlow<T>({intervalSeconds, expiresInSeconds,
waitBeforeFirstPoll?, poll, signal})` used by all three device-code providers (Codex, Copilot,
xAI) — implements RFC 8628 §3.5's `slow_down` (server-supplied new interval preferred, else `+5s`
client-side per spec), a `CANCEL_MESSAGE`/`TIMEOUT_MESSAGE`/`SLOW_DOWN_TIMEOUT_MESSAGE` (the last
one specifically calls out **WSL/VM clock drift** as a known false-timeout cause — worth
carrying into Kortix's own poller error copy). **This is the one function to port near-verbatim**
— it is provider-agnostic by design and Kortix's three device-code providers (Codex, Copilot,
xAI) can share one implementation exactly as Pi's do.

### 2.7 The two-door TUI selector — `packages/coding-agent/src/modes/interactive/components/
oauth-selector.ts` (full read)

`AuthSelectorProvider = {id, name, authType: 'oauth'|'api_key', method?, status?}` — **one flat
list, not two separately-rendered sections** in Pi's actual TUI (contrary to a literal reading of
"two doors" as two screens): `formatAuthSelectorProviderType` renders `[subscription]` or
`[API key]` as a trailing label per row, shown only when `showAuthTypeLabels` is true (line 63:
`new Set(providers.map(p => p.authType)).size > 1` — i.e., the label only appears when the list
actually mixes both kinds, otherwise it's redundant noise). `formatStatusIndicator` (lines
164-181) renders one of: `• unconfigured` (muted), `• <mismatched-type> configured` (warning
color, when a provider has e.g. an API key stored but the user is trying to pick it from the
OAuth list), `✓ configured` (success, generic OAuth/stored-credential source), or `✓ env:
<VAR_NAME>` / `✓ <source>` (success, ambient-source specific). Fuzzy-filterable
(`fuzzyFilter(providers, query, p => \`${p.name} ${p.id} ${p.authType} ${p.method?.name}\`)`).
**Kortix's Models-page "Agent runtimes"/"Your connections" two-section layout (already shipped,
per the prerequisite UX spec §1.1) is actually closer to a literal two-door split than Pi's own
flat-list-with-label is** — this spec does not recommend changing Kortix's already-good two-
section layout to match Pi's flat list; it recommends matching Pi's **underlying data model**
(one `ProviderAuth`-shaped registry entry per provider, `apiKey`/`oauth` fields presence-driven)
while keeping Kortix's already-superior two-section visual presentation. Cite this explicitly so
nobody "fixes" the Models page into a worse flat list chasing surface-level Pi parity.

### 2.8 Locked resolution/refresh — `packages/ai/src/auth/resolve.ts` (full read)

`resolveStoredOAuth` (lines 84-118): if `Date.now() >= credential.expires`, refresh runs **inside
`credentials.modify(providerId, fn)`** — a serialized read-modify-write per provider id — and
`fn` **re-checks expiry under the lock** (`if (Date.now() < current.expires) return undefined`,
line 98) before actually calling `oauth.refresh()`, so two concurrent callers hitting the same
expired credential produce exactly one network refresh, not two. **This is architecturally
identical to Kortix's own `credentials/codex.ts` `inflightRefresh` single-flight map
(codex.ts:47,83-94)** — independently arrived at, same problem, same solution shape. Confirms
Kortix's existing pattern is correct and should be the template for the new `credentials/
claude.ts` and any other refreshable OAuth kind, not reinvented from Pi's lock primitive
verbatim (Kortix's DB-backed row is the lock target; Pi's is an in-process file lock — different
mechanism, same guarantee).

### 2.9 What is deliberately NOT ported

- Pi's `CredentialStore` is a local `auth.json` file (`packages/coding-agent/src/core/
  auth-storage.ts`, `proper-lockfile`-guarded, `chmod 0o600`) — **Kortix's storage stays
  `project_secrets`**, per the owner's explicit "whatever way we store it" being already decided
  (one DB table, multi-tenant, shared-vs-personal scoping Pi has no equivalent for). Nothing
  about Pi's file-based store is relevant to Kortix's server-multi-tenant shape.
- Pi's `AuthContext`/ambient-env resolution (AWS profiles, ADC files, `~/.aws/credentials`) is a
  single-user-machine concept with no Kortix equivalent (a sandboxed agent process has no
  ambient host credentials to discover) — not ported.
- Pi's `ImagesModels`/`ImagesProvider` auth (separate from `Models`) — out of scope, Kortix's
  auth surface here is LLM harness credentials only.

---

## 3. Service boundary

### 3.1 Where the new code lives, and why

**New module: `apps/api/src/llm-gateway/auth/**`** — confirmed empty/nonexistent today (no
`apps/api/src/llm-gateway/auth` directory exists on this branch; `credentials/` and
`resolution/` are its only siblings). This is the owner's literal ask ("in our LLM gateway
service") and it is uncontested — nothing else claims this path.

```
apps/api/src/llm-gateway/auth/
  registry.ts            — AuthProviderDescriptor table (§4) + lookup helpers
  registry.test.ts        — round-trip assertions (every entry's producesAuthKind exists in
                             HARNESSES somewhere; every OAuth entry's flows are non-empty; etc.)
  oauth/
    pkce.ts                — ported from pi/packages/ai/src/auth/oauth/pkce.ts (§2.5), verbatim algorithm
    device-code-poller.ts  — ported from pi/packages/ai/src/auth/oauth/device-code.ts (§2.6)
    flow-state.ts           — opaque encrypted flow-handle helpers, generalizing r3.ts's
                              inline encryptProjectSecret(JSON.stringify({...})) pattern (§1.1)
                              into one reusable {seal, open} pair every provider adapter calls
    anthropic.ts            — browser-oauth + paste-fallback adapter (CLI + gated web paths)
    openai-codex.ts          — browser-oauth (CLI) + device-code (web+CLI) adapter — supersedes
                              the OpenAI-only logic embedded directly in r3.ts today
    github-copilot.ts        — device-code adapter, + the Copilot-token-exchange +
                              enable-all-models post-steps from §2.4
    xai.ts                   — device-code adapter
  credentials/
    claude.ts                — NEW, mirrors codex.ts's shape (§5.2) — health/expiry only in Tier
                              A; refresh only if/when Anthropic's real OAuth token is adopted
    api-key.ts                — NEW, generic liveness check for plain provider keys (§5.3)
  resolve-credential-status.ts — NEW, the CredentialStatus computation (§5.1) every UI/CLI
                              surface reads instead of hand-deriving "Connected"/"Needs attention"
```

`apps/api/src/llm-gateway/resolution/harness-models.ts` **is not touched by this reorganization**
— it already imports `resolveCodexCredential` from `../credentials/codex` (harness-models.ts:38)
and will import `resolveClaudeCredential` from the new `../credentials/claude` the same way once
built (§10 Step 2). The registry and OAuth machinery in `auth/**` are a layer **above**
`credentials/**` and `resolution/**`, not a replacement for either: `auth/registry.ts` describes
*how a user connects*; `credentials/*.ts` resolves *whether a stored connection is currently
usable*; `resolution/harness-models.ts` combines that with the capability matrix to answer *can
this harness start*. Three questions, three modules, one direction of dependency
(`auth → credentials → (consumed by) resolution`).

### 3.2 The registry schema

```ts
// apps/api/src/llm-gateway/auth/registry.ts
import type { HarnessAuthKind } from '@kortix/shared/harnesses';

export type AuthDoor = 'account' | 'api-key';
export type AuthFlow = 'browser-oauth' | 'device-code' | 'paste-token' | 'paste-api-key';

export interface OAuthClientConfig {
  clientId: string;
  authorizeUrl?: string;      // absent for device-code-only providers (they have no /authorize)
  tokenUrl: string;
  deviceCodeUrl?: string;     // present iff 'device-code' is in flows
  scopes: string[];
  pkce: boolean;              // true for browser-oauth; irrelevant for pure device-code
  cliRedirectUri: string;     // e.g. http://127.0.0.1:53692/callback — CLI-only, never used by web
  cliRedirectPort: number;
}

export interface AuthProviderDescriptor {
  id: string;                       // 'anthropic' | 'openai' | 'github-copilot' | 'xai' | ... (BYOK ids from @kortix/llm-catalog)
  label: string;                    // "Claude Code" | "ChatGPT / Codex" | "GitHub Copilot" | "xAI" | "Anthropic" ...
  door: AuthDoor;
  producesAuthKind: HarnessAuthKind;  // the ONE existing enum this maps into — no new taxonomy
  flows: {
    web: AuthFlow[];                  // ordered by preference for the browserless web surface
    cli: AuthFlow[];                  // ordered by preference for the CLI (real callback available)
  };
  oauth?: OAuthClientConfig;          // present iff door === 'account'
  apiKeyEnvVars?: string[];           // present iff door === 'api-key'; sourced from
                                       // @kortix/llm-catalog's primaryAuthEnvVars (unchanged)
  refresh: 'refresh-token' | 'none';
  gatedBehind?: 'anthropic_oauth_oneclick'; // the ONE flag-gated flow (§7, §11 #1)
  postAuthSteps?: 'copilot-enable-models';  // provider-specific post-login step, §2.4
  docsUrl?: string;
}
```

**Why `producesAuthKind` and not a new taxonomy**: the entire downstream machinery (§1.1) is
already built against `HarnessAuthKind`. A `PROVIDERS` table that invented its own kind enum
would require a second mapping layer and a second place to keep the two in sync — exactly the
"two hand-maintained arrays that must agree" anti-pattern `compatibleHarnessesFor` was built to
kill (harnesses.ts:151-160's own doc comment). Every registry entry produces **exactly one**
`HarnessAuthKind`; `compatibleHarnessesFor(entry.producesAuthKind)` is how a UI answers "which
harnesses does connecting this light up" — already-built code, zero new logic.

`registry.test.ts`'s one load-bearing assertion: **every `HarnessAuthKind` value that appears in
`HARNESSES[*].authKinds` anywhere has at least one registry entry whose `producesAuthKind`
matches it**, except `managed_gateway` (not a connectable provider — it's Kortix's own included
route, has no registry row) and `native_config` (not connectable via this UI at all — a committed
config file). This is the mechanical proof the registry is a superset/mirror of the capability
matrix's leaves, not a third independently-authored list.

### 3.3 What does NOT move into `apps/api/src/llm-gateway/auth/**`

- **Storage** — `project_secrets` stays in `apps/api/src/projects/secrets.ts`. Per the same
  reasoning `2026-07-21-model-resolution-refactor-plan.md` §2 already gave and this document
  re-affirms (§4): it is a generic encrypted KV store also serving non-model secrets (connector
  credentials). Moving it would wrongly couple an unrelated secret-storage concern to
  LLM-specific code, and it would be a needless breaking change to every existing caller
  (`listProjectSecrets`, `listResolvedProjectSecrets`, the connector/Pipedream path, the CLI's
  generic `kortix secrets` command).
- **Harness identity, session/sandbox mechanics, ACP launch-env translation** — stays in
  `apps/api/src/projects/lib/**` and `apps/kortix-sandbox-agent-server/src/acp/**`. The gateway's
  auth module answers "what credential, in what health, unlocking what" — it has no business
  knowing what a sandbox is, matching the existing ownership table.
- **`composer-capabilities.ts`'s connections-LISTING UI shape** (`buildHarnessConnections`,
  `CONNECTIONS` display metadata: labels, icons, `Used by` copy) — stays a `projects/lib`
  concern that *reads* the new registry for its data, the same way it already reads
  `HARNESSES`/`compatibleHarnessesFor` rather than owning that data itself.

---

## 4. Storage — one store, a normalized read-side shape, no new column unless named

**Direct answer: no new store.** `project_secrets` already holds every credential kind
(§1.1). What's missing is a **normalized in-memory/API record shape** on the read side —
requested explicitly by the task brief ("typed status: healthy/expired/invalid/unverified,
refresh metadata, provider id, kind").

```ts
// apps/api/src/llm-gateway/auth/resolve-credential-status.ts
export type CredentialStatus = 'healthy' | 'expired' | 'invalid' | 'unverified' | 'absent';

export interface CredentialRecord {
  providerId: string;          // registry id, e.g. 'anthropic', 'github-copilot'
  authKind: HarnessAuthKind;   // == the registry entry's producesAuthKind
  door: AuthDoor;
  scope: 'shared' | 'personal';
  status: CredentialStatus;
  refreshable: boolean;        // registry.refresh === 'refresh-token'
  expiresAt: number | null;    // epoch ms, null if unknown/non-expiring
  lastCheckedAt: number | null; // null for 'unverified' — presence-only, never live-probed
  reason: string | null;       // human string for expired/invalid, mirrors harness-models.ts's `reason` field shape
}

export async function resolveCredentialStatus(
  projectId: string,
  userId: string | null,
  providerId: string,
): Promise<CredentialRecord>;
```

This is a **read-side projection over the same `project_secrets` rows** `harness-models.ts`
already reads via `env: Record<string,string>` — it does not duplicate storage, it duplicates
*none* of the logic either: for `codex_subscription` it delegates to the existing
`resolveCodexCredential` and maps `CodexRefreshError` → `status: 'expired'`; for
`claude_subscription` it delegates to the new `credentials/claude.ts` (§5.2); for every API-key
kind it delegates to the new `credentials/api-key.ts` liveness check (§5.3) when one exists, else
falls back to `status: 'unverified'` (present, never probed — the honest state for "a key exists
and we haven't spent a request confirming it works," distinct from `healthy`).

**No `project_secrets` schema change is required for this document's Tier-A/B scope.** The one
column that would be genuinely new — a persisted `last_checked_at`/`status` cache to avoid
re-probing on every read — is **flagged, not proposed**: `CredentialRecord.status` can be
computed live on every request (Codex already does this; a live check costs one refresh-token
call at most, already acceptable per `codex.ts`'s existing behavior). If probe cost becomes a
problem (e.g. the API-key liveness check in §5.3 making a real upstream call per page load),
the fix is an in-process/Redis cache keyed by `(projectId, providerId)` with a short TTL, **not**
a new DB column — flagged loudly per the task's instruction, but the honest recommendation is:
do not add a column until a measured performance problem justifies it.

---

## 5. Credential resolution — the two new modules

### 5.1 What's reused unchanged

`isCredentialConfigured` (harness-models.ts:147-177) stays exactly as-is for the
`configured`-set computation `resolveHarnessModels` needs (presence, not health — that
distinction is intentional and already correct per that module's own doc comment). This
document's new health checks feed `resolve-credential-status.ts` (§4), a **separate** read path
for UI/CLI display — `resolveHarnessModels` itself is not modified by this document; its Codex
branch (harness-models.ts:432-453) already calls `resolveCodexCredential` and treats
`CodexRefreshError` as `expired` — the pattern §5.2 replicates for Claude is additive, wired into
`resolveHarnessModels`'s `claude_subscription` path the same way (one new `if (kind ===
'claude_subscription')` branch mirroring lines 432-453, **not** a restructuring of the function).

### 5.2 `credentials/claude.ts` — new, mirrors `codex.ts`'s shape exactly

Per `2026-07-21-claude-subscription-parity.md` §3 Tier A (already fully speced, not re-derived
here, only located in the new module):

```ts
export async function resolveClaudeCredential(
  projectId: string, userId: string,
): Promise<{ token: string; expiresAt: number | null } | null>
```

- Reads `CLAUDE_CODE_OAUTH_TOKEN` via the same shared/personal row precedence as
  `loadCodexRow` (codex.ts:30-45) — copy the query shape, not the Codex-specific parsing.
- **No refresh call in Tier A** — per the parity doc's finding (unverified whether a `claude
  setup-token`-minted token has any refresh mechanism at all; public reporting suggests a
  long-lived ~1-year bearer, not confirmed against Anthropic's own docs). This module's job is
  **expiry tracking, not refresh**: if the stored value round-trips through a `{token, expires}`
  JSON envelope written by a future browser-OAuth flow (§7, gated), decode `expires` and compare
  to `Date.now()`; if it's the plain string a `setup-token` paste writes today (`claude-
  subscription-form.tsx:66-69`'s `upsertProjectSecret`), there is no expiry to check —
  `status: 'unverified'` forever unless a live probe (below) says otherwise.
- **A cheap live "test connection" probe**, exactly as the parity doc's Tier A item 3 specifies:
  one minimal authenticated request to Anthropic (smallest viable completion or a lightweight
  endpoint that validates a bearer without meaningful spend) — this is the thing that can flip
  `unverified` → `healthy`/`invalid`. Rate-limited server-side (don't let a UI poll hammer it);
  never logs the raw token, matching `codex-subscription.ts`'s existing discipline
  (r3.ts-adjacent file, lines 42-45 per the parity doc).
- **Fail-closed wiring into session start**: once this module exists, `resolveHarnessModels`'s
  `claude_subscription` branch gains the same `expired` short-circuit Codex already has
  (harness-models.ts:443-452's pattern), closing the parity doc's item 4 gap (today a stale
  Claude token still reads `configured` and is only discovered dead at the adapter's first
  request).

### 5.3 `credentials/api-key.ts` — new, generic liveness check for plain provider keys

Today every plain API-key kind (`anthropic_api_key`, `openai_api_key`, and every BYOK catalog
provider once the registry widens beyond the four named providers) is presence-only
(`isCredentialConfigured`'s `Boolean(env.X?.trim())`). This module adds one function:

```ts
export async function checkApiKeyLiveness(
  providerId: string, apiKey: string,
): Promise<'healthy' | 'invalid' | 'unverified'>
```

Implementation: a per-provider cheap-probe table (mirrors `@kortix/llm-catalog`'s existing
`primaryAuthEnvVars`/auth-requirement declarations — extend that package with an optional
`livenessProbe: {method, path}` per provider rather than inventing a second per-provider table
here). **Scope explicitly capped**: this document specifies the shape and the four launch
providers' probes (Anthropic, OpenAI, GitHub Copilot's token-exchange step doubles as its own
liveness check, xAI); wiring every remaining BYOK catalog provider's probe is `Extensible
registry for future providers` work (§7), not a Phase-1 blocker — `unverified` is a perfectly
honest default status for a provider whose probe hasn't been written yet, it is not a bug.

---

## 6. OAuth callback infrastructure

### 6.1 The web/CLI split, stated as the load-bearing design decision

**Every browser-OAuth provider in this matrix (Anthropic, OpenAI Codex) registers a
`localhost`-bound redirect URI with the provider** (§2.2, §2.3 — `127.0.0.1:53692` and
`localhost:1455` respectively). **This is not a Kortix limitation to work around — it is a fact
about how these providers issue OAuth clients**, confirmed by reading Pi's own client
configuration verbatim. A hosted web origin (`app.kortix.com`) can never receive that redirect
directly. Per the owner's addendum, the resolution is not "build a proxy redirect" or "run a
disposable localhost listener from the browser" (impossible — browsers cannot bind TCP listeners)
— it is: **the CLI is the only surface that ever runs `browser-oauth` for these two providers.
Web uses device-code (Codex) or paste (Anthropic) exclusively.**

| Provider | CLI flows (ordered) | Web flows (ordered) |
|---|---|---|
| Anthropic (account) | `browser-oauth` (real local callback, gated §7/§11#1) → `paste-token` (`setup-token`, sanctioned default) | `paste-token` (`setup-token`, sanctioned default) only — no browser-oauth attempt, no fake localhost dance |
| OpenAI/Codex (account) | `browser-oauth` (real local callback on `:1455`) → `device-code` | `device-code` only (already shipped shape, `chatgpt-subscription-form.tsx`) |
| GitHub Copilot (account) | `device-code` (only flow that exists) | `device-code` (identical — no surface difference at all) |
| xAI (account) | `device-code` (only flow that exists) | `device-code` (identical) |
| Every API-key provider | `paste-api-key` | `paste-api-key` (identical — already how it works today) |

**This table is the entire "flow matrix per provider × surface" the owner asked for.** Two of
five rows (Copilot, xAI) require zero web/CLI branching at all. Anthropic's web row is not a
degraded fallback — it *is* the sanctioned mechanism regardless of surface (per
`2026-07-21-claude-subscription-parity.md` §2's Anthropic policy finding), so "browserless
Anthropic on web" costs nothing not already true today.

### 6.2 CLI browser-login — real callback server, full parity with pi/codex CLIs

New: `apps/cli/src/commands/providers-oauth-callback.ts` (or inlined into a widened
`providers.ts`) — a Node `http.createServer` bound to the registry's `cliRedirectPort`
(`53692` for Anthropic, `1455` for Codex — **must match the provider's registered redirect
exactly**, these ports are not configurable per-deployment, they are the provider's own OAuth
client registration). Ported near-verbatim from `anthropic.ts:99-168`/`openai-codex.ts:319-393`
(§2.2/§2.3): race a `waitForCode()` promise against a `manual_code` terminal prompt (CLI already
has `readline`-based prompt helpers in `providers.ts`'s `readSecret`/`readVisible`, reused here
for the manual-paste fallback), serve the exact completion HTML on success (`oauth-page.ts`'s
`oauthSuccessHtml`/`oauthErrorHtml` pattern, ported as static strings — no templating engine
needed, it's two fixed HTML strings).

**Where PKCE state lives**: generated client-side in the CLI process (it already has Node's
`crypto`/Web Crypto available), verifier held in CLI process memory only for the duration of the
login command — **never sent to or stored by the Kortix API** until the final authorization code
exchange, which the CLI performs directly against the provider's own `TOKEN_URL` (matching Pi's
architecture exactly — the CLI *is* the OAuth client, Kortix's API is not a party to the
code-for-token exchange at all for the CLI browser-login path). Once the CLI holds
`{access, refresh, expires}`, it `POST`s the finished credential to
`/projects/:projectId/oauth-credentials/:providerId` (new route, §6.4) for storage — the CLI
never round-trips through Kortix's server mid-flow the way the device-code flow does, because it
doesn't need to (no cross-device polling problem to solve).

### 6.3 Web device-code and paste flows — server-authoritative, generalizing the existing pattern

**This is the flow that already exists for Codex (§1.1) and this document generalizes it.**
Server-authoritative because the whole point of device-code/paste on web is that the browser
tab **is not** the OAuth client — the Kortix API is, on the user's behalf, for the duration of
the flow only (not persistently — the resulting token, once obtained, is `relay-eligible`
custody per `CREDENTIAL_CUSTODY`, already-shipped policy, §1.1).

Routes (replacing `r3.ts`'s hardcoded `OAUTH_PROVIDERS = {openai: {...}}`, §10 kill-list):

```
POST   /projects/:projectId/oauth-credentials/:providerId/start
POST   /projects/:projectId/oauth-credentials/:providerId/poll
GET    /projects/:projectId/oauth-credentials
DELETE /projects/:projectId/oauth-credentials/:providerId
```

(Renamed from `/oauth/:provider/*` to `/oauth-credentials/:providerId/*` — deliberate, not
cosmetic: `oauth` collided conceptually with "the CLI's own client-side OAuth exchange" in §6.2;
`oauth-credentials` names what the route actually does, store/poll a credential, regardless of
which flow produced it. Old routes stay mounted as a compatibility alias returning the identical
shape during the migration window, §10.)

`start` looks up the registry entry, branches on `flows.web[0]`:
- `device-code` → identical shape to today's Codex `start` (r3.ts:707-787): call the provider's
  device-code endpoint from `registry.oauth.deviceCodeUrl`, seal `{deviceAuthId/equivalent,
  userCode, sharing, uid, expiresAt}` into the **same opaque-encrypted-handle pattern** already
  proven (r3.ts:768-777), generalized to any provider by making the sealed payload's shape a
  per-provider adapter concern (`auth/oauth/flow-state.ts`'s `seal<T>(projectId, T)`/`open<T>
  (projectId, string): T | null` generic helpers, §3.1) rather than the Codex-specific inline
  object literal r3.ts has today.
- `paste-token` (Anthropic) → **no `start` call at all** — this is exactly today's already-
  shipped `claude-subscription-form.tsx` two-step Stepper (show `claude setup-token` instructions
  + a copy button, then a password-masked paste field, `upsertProjectSecret` on submit). Nothing
  in this document changes that flow's shape; it becomes registry-driven only in the sense that
  the connect modal looks up "Anthropic's account door renders the paste-token component" from
  the registry instead of a hardcoded `if (kind === 'claude_subscription')` branch (§8).

`poll` is provider-agnostic already (r3.ts:791-856's shape generalizes cleanly — decrypt handle,
call the provider's token endpoint via the registry's adapter, on success call
`writeCredentialSecret` (the Codex-specific `writeCodexAuthSecret`, r3.ts:631-688, generalized to
take a `providerId`/`secretName` pair from the registry entry instead of being hardcoded to
`CODEX_AUTH_JSON`).

### 6.4 PKCE state for the (gated) web-initiated browser-OAuth case

**Only relevant if/when §11 open decision #1 (Anthropic one-click) is flipped on** — until then,
web never attempts `browser-oauth` at all (§6.1's table), so this subsection is forward-looking,
not required for Phase 1.

If ever built: PKCE verifier/state generated **server-side** (not client-side — a browser tab
cannot be trusted to hold a verifier across the redirect without it appearing in browser history/
referrer headers on the authorize-URL hop, and per §6.1 the redirect target is
`localhost`-bound anyway, meaning a purely-web browser-OAuth flow **cannot work at all** for
Anthropic/Codex without the provider issuing Kortix a **new, distinct OAuth client with a
`https://app.kortix.com/auth/callback`-shaped redirect** — a business/partnership step, not an
engineering one, and exactly the kind of "sanctioned by the provider" question §11 #1 already
flags. **This subsection is explicitly not actionable today** — recorded here only so a future
implementer doesn't rediscover the localhost blocker from scratch.

### 6.5 The completion page

New: `apps/web/src/app/auth/callback/[provider]/page.tsx` (or a single `apps/web/src/app/auth/
callback/page.tsx?provider=...&code=...&state=...`, either shape works — a single dynamic route
avoids a per-provider page file). **Only reachable at all in the CLI real-callback path today**
(§6.1) — the CLI's local server serves the completion HTML **itself** (§6.2, ported strings, no
network round-trip to `app.kortix.com` needed), so this web route is **dormant/unused until
§11 #1 is decided** and a provider issues a non-localhost redirect. Built now anyway (cheap,
~40 lines, matches the design system) so it exists the moment it's needed, styled per the
sibling UX spec's completion-page convention (§8.2's wireframe) rather than reusing the CLI's
raw HTML strings (which are terminal-appropriate, not Kortix-branded).

### 6.6 Sequence diagrams

**(1) CLI browser-login (Anthropic, once §11#1 ships; Codex, available now in principle)**

```
1. kortix providers login anthropic --browser
2. CLI generates PKCE {verifier, challenge}, starts local http server on :53692
3. CLI opens https://claude.ai/oauth/authorize?...&code_challenge=...&redirect_uri=
   http://localhost:53692/callback in the default browser
4. User authorizes in their normal, already-logged-in browser session
5. claude.ai redirects the browser to http://localhost:53692/callback?code=...&state=...
6. CLI's local server receives the callback, serves "Authentication completed —
   you can close this window.", resolves the code
7. CLI exchanges {code, verifier} directly with platform.claude.com/v1/oauth/token
   (no Kortix API involved in this exchange)
8. CLI POSTs the resulting {access, refresh?, expires} to
   POST /projects/:id/oauth-credentials/anthropic/store (new, direct-store variant —
   distinct from start/poll because there's no cross-device wait to bridge)
9. API writes CLAUDE_CODE_OAUTH_TOKEN (or the richer JSON envelope, §5.2) to
   project_secrets via the existing encryptProjectSecret path
```

**(2) Web paste-fallback (Anthropic, the actual default — not a fallback in practice)**

```
1. User opens Models page -> Connect -> "Sign in with an account" -> Claude Code
2. Web shows: run `claude setup-token` in your terminal, paste the printed token
3. User pastes; web calls POST /projects/:id/secrets {name: CLAUDE_CODE_OAUTH_TOKEN, value}
   (unchanged from today's claude-subscription-form.tsx — this document does not touch this path)
4. Models page re-fetches composer-capabilities; connection row flips to Connected
```

**(3) Web device-code (Codex — the shipped shape this document generalizes)**

```
1. User opens Models page -> Connect -> "Sign in with an account" -> ChatGPT / Codex
2. Web calls POST /projects/:id/oauth-credentials/openai/start
3. API calls OpenAI's device-code endpoint, seals state into an opaque handle, returns
   {flow_id (opaque), verification_url, user_code, expires_at, interval_ms}
4. Web shows the code + a link, opens the verification_url in a new tab
5. User authorizes on OpenAI's own page in that new tab
6. Web polls POST /projects/:id/oauth-credentials/openai/poll {flow_id} every interval_ms
7. API decrypts the handle, polls OpenAI's token endpoint; on success, persists
   CODEX_AUTH_JSON via the existing writeCodexAuthSecret-shaped write, returns {status:'success'}
8. Web shows Connected; Models page composer-capabilities re-fetch reflects it
```

**(4) CLI device-code (Copilot, xAI, or Codex via the headless menu option)**

```
1. kortix providers login github-copilot   (or --device-code on a provider that also offers browser)
2. CLI calls the SAME POST /projects/:id/oauth-credentials/:providerId/start route web uses
   (this is the one flow CLI and web share verbatim — no CLI-specific server code at all)
3. CLI prints the code + URL, opens the URL, polls the SAME /poll route
4. On success, CLI prints "Authorized <provider> on this project" (matches providers.ts:280-292
   today, unchanged in shape, generalized beyond the single OAUTH_PROVIDERS.has('openai') gate)
```

---

## 7. Provider matrix v1

| Provider | Door(s) | `producesAuthKind` | Flows (web) | Flows (CLI) | Refresh | Custody (from `CREDENTIAL_CUSTODY`, unchanged) | Notes |
|---|---|---|---|---|---|---|---|
| **Anthropic** | account + api-key | `claude_subscription` / `anthropic_api_key` | account: `paste-token` (default, sanctioned) — api-key: `paste-api-key` | account: `paste-token` (default) or `browser-oauth` **gated off** (§11#1) — api-key: `paste-api-key` | none known (Tier A, unverified — §5.2) | `direct-only` | The account door's shell is identical to every other provider's — same registry shape, same UI row — but its default flow is wired to the sanctioned `setup-token` paste, and `browser-oauth` is present in the schema but `gatedBehind: 'anthropic_oauth_oneclick'` (off by default, owner must flip explicitly). |
| **OpenAI (Codex)** | account only | `codex_subscription` | `device-code` (shipped) | `browser-oauth` (default, real `:1455` callback) or `device-code` | `refresh-token` (shipped, `codex.ts`) | `relay-eligible` (credential never leaves Kortix's server, per parity doc) | Already exists end to end server-side (§1.1); this document generalizes its route/registry shape, does not change its behavior. |
| **GitHub Copilot** | account only | (new `HarnessAuthKind`? — see below) | `device-code` | `device-code` | `refresh-token` (Copilot's own token-exchange step, §2.4) | `relay-eligible` (no reason to differ from Codex's shape) | **Server currently 400s the old CLI path** (per the CLI's own comment, `providers.ts:104-109`, citing `2026-07-21-cli-credential-model-ux.md`) — enabling it requires: (a) a new `HarnessAuthKind` value (`github_copilot_subscription`) since none of today's 8 values fit a Copilot-backed model route, (b) a `HARNESSES[*].authKinds` entry on whichever harness(es) should accept it (none do today — Copilot has no natural harness owner the way Claude/Codex do; likely candidate: OpenCode/Pi via a new OpenAI-compatible-shaped adapter pointed at the credential-derived `proxy-ep` base URL, §2.4), (c) the two-step token exchange + `enableAllGitHubCopilotModels` post-auth step (§2.4) — this is real, scoped engineering work, not a config flip, flagged in §11. |
| **xAI** | account + api-key | `anthropic_compatible`/new kind — **unresolved, same gap as Copilot** | `device-code` | `device-code` | `refresh-token` | `relay-eligible` | Same "no existing `HarnessAuthKind` fits an xAI subscription" gap as Copilot — xAI's *API-key* door already works today (`XAI_API_KEY`, listed in `@kortix/llm-catalog`) via the existing `openai_api_key`-shaped generic path; only the *account/subscription* door is new. |
| **Every other BYOK provider already in `@kortix/llm-catalog`** (OpenRouter, Google, Groq, DeepSeek, Mistral, Bedrock, …) | api-key only | `openai_api_key`/`anthropic_api_key`/`openai_compatible` per existing mapping | `paste-api-key` | `paste-api-key` | none | `relay-eligible` | Zero new work — already fully wired (`CATALOG`, `primaryAuthEnvVars`, `PROVIDER_ENV_VARS` in the CLI, `connect-model-modal.tsx`'s API-keys section) — the registry's api-key rows are a thin wrapper generated from `@kortix/llm-catalog` directly, not hand-authored per provider (§9, Step 1). |

**The Copilot/xAI `HarnessAuthKind` gap is the single largest piece of net-new scope in this
matrix**, larger than the OAuth-plumbing work itself — flagged prominently, not buried: adding
either provider's *account* door for real requires touching `packages/shared/src/harnesses.ts`
(new enum value(s), a new row in `CREDENTIAL_CUSTODY`, a decision about which harness(es) accept
it) — that file is **currently being edited by another agent on this branch** (§0's in-flight
list). **Do not touch `harnesses.ts` in Phase 1** of this spec's execution (§9) — ship the
registry and OAuth plumbing for the two providers that already have a `HarnessAuthKind`
(Anthropic, Codex) first; Copilot/xAI's account door is explicitly Phase-2/parked pending that
coordination (§11 open decision #4).

**Extensibility**: a new provider (any door) is: one `AuthProviderDescriptor` row (§3.2) plus,
only for a new *account*-door provider whose credential should unlock a harness, one
`HarnessAuthKind` value + one `HARNESSES[*].authKinds` entry + one `CREDENTIAL_CUSTODY` entry.
API-key-only providers need zero changes outside `@kortix/llm-catalog` + one registry row — this
is the "extensible registry for future providers" the task asked for, demonstrated structurally
rather than asserted.

---

## 8. Distribution — one registry, every consumer reads it

### 8.1 The resolver

`resolveHarnessModels` (§1.1, unchanged) already takes `env: Record<string,string>` and a
`explicit?: HarnessAuthKind` — nothing about this document's registry changes that function's
signature. The registry's role is entirely upstream of it: **producing** the `env` entries (via
the OAuth/paste flows writing `project_secrets` rows, §6) and **describing** the UI that lets a
user pick an `explicit` kind. The resolver stays the single per-(project, harness) authority;
this document does not add a second one.

### 8.2 Launch env — fail-closed, exactly one credential per launch, unchanged mechanism

`isolateHarnessAuthEnv` (§1.1, `harness-registry.ts`, unchanged by this document) is the
existing fail-closed guarantee: it deletes every provider-credential env var and re-admits only
the active kind's. Nothing in the new registry weakens or duplicates this — a new provider (e.g.
Copilot, once its `HarnessAuthKind` exists) is fail-closed automatically the moment its kind is
added to `AUTH_ENV_BY_KIND` (the existing per-kind allowlist table this function reads), the same
mechanism every existing kind already goes through.

### 8.3 CLI and web read the same registry — literally, not "in spirit"

**Concrete mechanism**: `apps/api/src/llm-gateway/auth/registry.ts` is server-side TypeScript. It
cannot be imported directly by the browser or the CLI binary (server-only dependencies — DB
types, etc., even if the descriptor data itself is inert). The registry is exposed via one new
read route:

```
GET /projects/:projectId/auth-providers
→ { providers: Array<{
      id, label, door, producesAuthKind, compatibleHarnesses: HarnessId[],  // compatibleHarnessesFor(producesAuthKind)
      flows: { web: AuthFlow[] },   // CLI reads its OWN flows.cli from its own copy (below) —
                                     // the response only needs to describe what THIS caller can render
      status: CredentialRecord | null,  // §4 — null if never connected
      gated: boolean,               // true if gatedBehind is set and the flag is off
    }> }
```

This is the **existing** `/harness-connections` route's replacement/superset (per the
prerequisite plan's kill-list intent), not a new parallel endpoint — `composer-capabilities.ts`'s
route handlers call the registry the same way they already call `resolveHarnessModels`.

**The CLI's `flows.cli` ordering is a compiled-in constant**, not fetched from the server per
call (§3.2's `AuthProviderDescriptor.flows.cli` — the CLI ships with `@kortix/shared`'s registry
data, the same way it already ships `HARNESSES`/`compatibleHarnessesFor` today via that package).
**This is the mechanism that makes "CLI and web render identically" literal rather than
aspirational**: both read `AuthProviderDescriptor[]` from the same exported table — web via the
`GET /auth-providers` projection (server can't ship server-only fields like `OAuthClientConfig`'s
secrets to the browser, so the projection strips `oauth.clientId`/URLs the browser never needs
to see directly since it never drives OAuth itself, §6.1), CLI via a **new browser/RN-safe
sibling package export**, `packages/shared/src/auth-providers.ts` (the non-secret half of the
registry — `id`, `label`, `door`, `producesAuthKind`, `flows` — genuinely dependency-free,
mirroring how `harnesses.ts` itself is dependency-free per its own doc comment). The **secret**
half (`OAuthClientConfig`'s URLs/scopes/`clientId`) stays server-only in
`apps/api/src/llm-gateway/auth/registry.ts`, which imports and extends the shared non-secret
table — same split `codex.ts`/`harness-models.ts` already have between `@kortix/shared` (public,
dependency-free) and `apps/api` (server, DB-backed).

### 8.4 Where each surface mounts it

- **Composer connect entry** (`connect-model-modal.tsx`) — reads `GET /auth-providers`, renders
  the two-door split (§9.1) instead of its current `CONNECTIONS`-table-driven method list.
- **Models page** (`models-view.tsx`, `connection-row.tsx`) — same data source; the `Used by
  <harnesses>` line (`connection-row.tsx`'s `metadataLine`, unchanged component per the UX spec's
  finding it's already correct) reads `compatibleHarnesses` straight off the registry response.
- **CLI `kortix providers`** — `providers.ts` is rewritten to iterate the shared
  `packages/shared/src/auth-providers.ts` table instead of its own hardcoded
  `PROVIDER_CATALOG_ID`/`OAUTH_PROVIDERS` maps (§10, kill-list item).

---

## 9. UX blueprint

### 9.1 The two-door modal — ASCII wireframe

Building on the already-shipped `connect-model-modal.tsx` shape (per the prerequisite UX spec's
finding that the current two-section layout is already correct — this is a data-source change,
not a visual redesign):

```text
Connect a model service
Use a subscription, API key, or compatible endpoint.

Sign in with an account
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ Claude Code                                                        + │
│   Claude Pro, Max, Team, or Enterprise · setup-token paste             │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ ChatGPT / Codex                                          Connected + │
│   ChatGPT Plus, Pro, Business, Edu, or Enterprise · device code        │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ GitHub Copilot                              [Coming soon / gated]    │
│   Individual, Business, or Enterprise · device code                    │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ xAI                                          [Coming soon / gated]   │
│   SuperGrok or X Premium · device code                                 │
└────────────────────────────────────────────────────────────────────────┘

Sign in with an API key
[ Search providers… ]
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ Anthropic                                                          + │
│   Claude via your own API key                                          │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ OpenAI                                                              + │
│   GPT models via your own API key                                      │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ OpenRouter · Google · Groq · xAI · DeepSeek · Mistral · Bedrock · …  │
└────────────────────────────────────────────────────────────────────────┘
```

Header copy renamed from "Subscriptions" / "API keys & endpoints" to **"Sign in with an account"**
/ **"Sign in with an API key"** — the literal Pi phrasing the owner referenced, replacing the
current header strings (a copy-only diff to `connect-model-modal.tsx`'s section titles, no
structural change). Copilot/xAI rows render present-but-disabled (`[Coming soon]`) rather than
absent, per §7's flagged `HarnessAuthKind` gap — **absence would misrepresent "not built yet" as
"doesn't exist," which is worse than an honest disabled state** for two providers the owner
explicitly named as wanted.

### 9.2 Device-code panel (Codex today, Copilot/xAI once built) — unchanged from what ships

```text
◄ Back                          Connect ChatGPT / Codex

  Open this link and enter the code:

    https://auth.openai.com/codex/device                    [Copy link]

    Code:  W X Y Z - 1 2 3 4                                  [Copy code]

  Waiting for authorization…  ⠋
  (this closes automatically once you approve in the browser)
```

### 9.3 Paste-fallback panel (Anthropic default; also the CLI manual-code fallback)

```text
◄ Back                          Connect Claude Code

  1. Run this in your terminal:

       claude setup-token                                     [Copy]

  2. Paste the token it prints:

     [ ●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●● ]

                                                    [ Connect ]

  Use this connection for:  ☑ Claude Code
```

(Unchanged from `claude-subscription-form.tsx`'s already-shipped two-step Stepper — reproduced
here only to confirm it is the literal implementation of "paste-the-code... fallback" the owner
asked for, already built, not a gap.)

### 9.4 Completion page (CLI-served today; web route built dormant per §6.5)

```text
                              ✓
                 Authentication completed.
                 You can close this window.
```

Centered, minimal, matches `oauthSuccessHtml`'s copy exactly (§2.2) — Kortix-branded version
(logo mark, design-system colors) for the web route once it's live; the CLI's own served HTML
stays the plain terminal-appropriate version (no need to theme HTML served to `localhost` by a
CLI process the user never navigates to except via the OAuth redirect itself).

### 9.5 Error / expired / reconnect states

Reuses the credential-and-model-selection-ux spec's copy deck verbatim (§4.3 of that document)
— this spec adds no new copy strings, only a new `CredentialStatus` producer (§4/§5) feeding the
existing rendering rules (`Needs attention · <reason>`, `Reconnect <Harness>`, etc.). No
duplication of that spec's work.

### 9.6 Mount points

- Composer connect entry: `connect-model-modal.tsx` (data-source swap, §8.4).
- Models page: `models-view.tsx` / `connection-row.tsx` / `runtime-row.tsx` (unchanged
  components, new data source).
- CLI `kortix providers`: `apps/cli/src/commands/providers.ts` (rewritten to iterate the shared
  registry, §10).
- New: `apps/web/src/app/auth/callback/page.tsx` (dormant until §11#1, §6.5).

Follow the design system (`kortix-design-system` skill) for every new component — none of the
wireframes above introduce a new visual primitive; every element (row, badge, stepper, code
block with copy button, spinner) already exists in the design system per the prerequisite UX
spec's own audit.

---

## 10. Migration + kill-list

### 10.1 What dies

1. **`OAUTH_PROVIDERS: Record<string, {secretName}>` hardcoded to `{openai: {...}}`**
   (`apps/api/src/projects/routes/r3.ts:615-617`) — replaced by registry lookups. The
   `start`/`poll`/list/delete route **bodies** (r3.ts:707-940) are not deleted wholesale — their
   **logic** (opaque-handle sealing, any-replica polling, `writeCodexAuthSecret`'s shared/
   personal write) is generalized into `auth/oauth/*.ts` adapters + `auth/oauth/flow-state.ts`'s
   generic seal/open helpers (§6.3); the routes themselves move to
   `/oauth-credentials/:providerId/*` (§6.3) with the old `/oauth/:provider/*` paths kept as a
   compatibility alias during the migration window (§10.2 Step 4), then deleted.
2. **`OAUTH_PROVIDERS = new Set(['openai'])`** (`apps/cli/src/commands/providers.ts:110`) —
   replaced by iterating `packages/shared/src/auth-providers.ts`'s `door === 'account'` entries.
3. **`PROVIDER_CATALOG_ID`/`PROVIDER_ENV_VARS`** (`providers.ts:75-92`) — not deleted, but their
   *source* changes from a hand-authored `Record` to a derivation off the shared registry's
   `door === 'api-key'` entries (currently already sourced from `@kortix/llm-catalog` — this is a
   refactor of *where* that derivation lives, not new logic).
4. **`connect-model-modal.tsx`'s `CONNECTIONS`-table-driven method list** (whatever remains after
   the in-flight agent's current edit lands — §0's note that this file has active uncommitted
   changes; re-verify the exact current shape before starting this item, do not assume the
   version this document read is still current) — replaced by rendering `GET /auth-providers`
   directly.
5. **CLI's stale `ownsDefaultModelHarness` guard asserting `pi: true`**
   (`apps/cli/src/commands/agents.ts`, per `harnesses.ts:134-137`'s own code comment flagging
   this exact staleness) — not this document's core scope, but bundled into the CLI-touching
   step (§10.2 Step 5) since it's the same file family and already-identified as dead-wrong.

### 10.2 What does NOT change

- `project_secrets` schema — no new column, no new table (§4).
- The Codex relay + billing guarantees — `codexDescriptor`'s `billingMode:'none'` (per the
  transport-plan spec), `CREDENTIAL_CUSTODY['codex_subscription'] = 'relay-eligible'` — untouched.
- The Claude direct-to-adapter custody — `CREDENTIAL_CUSTODY['claude_subscription'] =
  'direct-only'`, `isolateHarnessAuthEnv`'s direct-forward branch — untouched, and this
  document's Claude work (§5.2) explicitly stays inside that custody rule (health-tracking only,
  no relay path built).
- `resolveHarnessModels`'s signature and state union (§1.1, §8.1) — untouched, only fed by a new
  upstream credential-writing path.
- `HARNESSES`/`CREDENTIAL_CUSTODY`/`compatibleHarnessesFor` in `packages/shared/src/harnesses.ts`
  — **untouched in Phase 1** (currently being edited by another agent, §0) — this document's
  Copilot/xAI work (§7) is explicitly Phase-2, gated on that file settling and on the owner's
  sign-off (§11 #4).

### 10.3 Sequenced steps, with lanes for parallel implementation agents

Each step names its owned files (no two concurrent steps touch the same file) and its test
requirement, per the `testing` skill's every-change-ships-with-tests rule.

**Step 0 — Registry skeleton (blocks everything, touches nothing live)**
- Owns: `packages/shared/src/auth-providers.ts` (new, non-secret half), `apps/api/src/llm-
  gateway/auth/registry.ts` (new, full descriptor incl. `OAuthClientConfig`), `registry.test.ts`
  (round-trip: every entry's `producesAuthKind` resolves via `HARNESSES`/`compatibleHarnessesFor`
  except `managed_gateway`/`native_config`).
- Entries: Anthropic (account+api-key), OpenAI/Codex (account), every existing `@kortix/llm-
  catalog` provider (api-key, derived not hand-authored). **Copilot/xAI account rows added as
  `gatedBehind`-style disabled placeholders only** — no new `HarnessAuthKind`, no `harnesses.ts`
  edit (§10.2).
- Risk: none, purely additive. Parallelizable with everything else in Phase 1.

**Step 1 — PKCE + device-code-poller ports (no product surface yet)**
- Owns: `apps/api/src/llm-gateway/auth/oauth/pkce.ts`, `device-code-poller.ts` (ports of §2.5/
  §2.6, cite the source file in a code comment per this repo's convention).
- Tests: PKCE verifier/challenge round-trip against a known S256 test vector; poller's
  `slow_down`/timeout/cancel branches (mirror Pi's own test file structure,
  `pi/packages/ai/test/oauth-device-code.test.ts`, as a shape reference only, not copied).
- Risk: none, dead code until Step 3.

**Step 2 — `credentials/claude.ts` + `credentials/api-key.ts`**
- Owns: `apps/api/src/llm-gateway/credentials/claude.ts`, `credentials/api-key.ts`, both `.test.ts`
  files, `apps/api/src/llm-gateway/auth/resolve-credential-status.ts`.
- Depends on: nothing (parallel with Steps 0-1). **Touches `harness-models.ts`'s
  `claude_subscription` branch** (one new `if` block mirroring the Codex branch,
  harness-models.ts:432-453) — coordinate with whoever else is mid-edit on `composer-
  capabilities.ts`/`agent-config-v2.ts` (§0) since they're adjacent files in the same module,
  even though this step doesn't touch those files directly.
- Tests: mirror `codex.test.ts`'s shape — shared/personal precedence, missing-row → null,
  decrypt-failure handling, expired/invalid/healthy branches with the live-probe mocked.
- Risk: low-medium (new credential-read path, no money/billing surface touched).

**Step 3 — `oauth-credentials/*` routes generalized from `r3.ts`'s Codex-only routes**
- Owns: `apps/api/src/llm-gateway/auth/oauth/flow-state.ts` (generic seal/open), `auth/oauth/
  openai-codex.ts`, `auth/oauth/anthropic.ts` (device/browser adapters — Anthropic's is built but
  its `browser-oauth` flow stays `gatedBehind`, unreachable, §7), a new route file
  (`apps/api/src/projects/routes/oauth-credentials.ts` or appended to `r3.ts` — **prefer a new
  file**, since `r3.ts` is already large per the task brief's own note it's a "route sprawl"
  target). Old `/oauth/:provider/*` routes in `r3.ts:707-940` become a thin compatibility shim
  calling the new routes, not deleted yet.
- Depends on: Step 0 (registry), Step 1 (PKCE/poller), Step 2 (for Anthropic's credential write
  path, though the flow itself doesn't need Step 2 to be usable — Anthropic's account door isn't
  reachable via browser-oauth yet regardless).
- Tests: contract test that `/oauth-credentials/openai/start` + `/poll` produce byte-identical
  behavior to today's `/oauth/openai/start`+`/poll` (a mechanical proof the generalization is
  lossless, matching the refactor plan's own "additive proof before deleting" discipline).
- Risk: medium — this is the real behavioral surface. Ship the new routes additive, verify against
  a live Codex OAuth session in the dev stack before flipping the CLI/web to call them (§10.2
  Step 5-6), keep the old routes live in parallel until verified.

**Step 4 — CLI real-callback browser-login + `providers.ts` registry rewrite**
- Owns: `apps/cli/src/commands/providers.ts` (rewritten to read `packages/shared/src/auth-
  providers.ts`), new `apps/cli/src/commands/providers-oauth-callback.ts` (the local server, §6.2),
  `apps/cli/src/commands/agents.ts`'s stale `ownsDefaultModelHarness` fix (§10.1 item 5, bundled
  since it's the same file family).
- Depends on: Step 0 (registry), Step 3 (routes for the device-code paths this file already
  calls, now provider-generic).
- Tests: CLI integration test mocking the local HTTP server's callback receipt; existing
  `agents-model.test.ts` updated for the `pi: false` correction.
- Risk: low-medium, CLI-only surface, no production web traffic affected.

**Step 5 — Web: `connect-model-modal.tsx` + Models page read the registry**
- Owns: `connect-model-modal.tsx` (**re-verify current shape first, §10.1 item 4 — another agent
  has uncommitted changes here right now**), `connection-row.tsx` (copy only — header rename,
  §9.1), new `apps/web/src/app/auth/callback/page.tsx` (§6.5, dormant).
- Depends on: Step 0 (registry), Step 3 (routes).
- Tests: existing `connect-model-modal` test suite updated for the registry-driven data source;
  a new snapshot test for the two-door header copy.
- Risk: medium — user-visible; coordinate explicitly with whichever of the three in-flight agents
  owns `connect-model-modal.tsx`'s current edit before starting, per this branch's own
  "shared-worktree parallel-agent wipe" lesson (memory: commit early, never let two agents clobber
  one file blind).

**Step 6 — Retire the compatibility alias**
- Owns: delete `r3.ts:707-940`'s original routes and `providers.ts`'s pre-Step-4 shape, once
  Steps 3-5 have been live and verified for one full release cycle (matches the transport-plan
  spec's own "observe before deleting the known-correct path" discipline).
- Risk: low by the time this runs, contingent on the observation window actually happening.

**Parallel lanes summary**: Steps 0, 1, 2 have zero file overlap and can run fully in parallel.
Step 3 depends on 0+1 (and loosely 2). Steps 4 and 5 depend on 3 and can run in parallel with
each other (CLI vs web, no file overlap). Step 6 depends on 4+5 being observed stable. Copilot/
xAI's `HarnessAuthKind` work (§7) is explicitly **not** in this sequence — it is Phase 2, blocked
on §11 #4.

---

## 11. Open decisions for the owner

1. **The Anthropic one-click flip (`gatedBehind: 'anthropic_oauth_oneclick'`).** Per
   `2026-07-21-claude-subscription-parity.md` §2 (Anthropic's own written policy, fetched
   primary-source, quoted verbatim there): *"Anthropic does not permit third-party developers to
   offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on
   behalf of their users."* This spec builds the browser-OAuth **shell** (PKCE, the CLI real
   callback, the registry row) because the CLI-only, direct-to-adapter shape (§6.1's Anthropic
   CLI row) plausibly reads as "ordinary use of Claude Code by the purchaser" (the parity doc's
   own Tier A/Tier C line-drawing) — but it ships **off**, and the registry entry does not
   silently enable it. **The owner must explicitly decide**: (a) leave it permanently off,
   `setup-token` paste stays the only Anthropic account path forever; (b) flip it on for the
   CLI-only real-callback shape (arguably defensible per the parity doc's own reasoning, still
   not legally confirmed); (c) never build it at all and delete the gated shell. This document
   takes no position beyond "do not silently enable it" — restated from the task brief because
   it is genuinely the highest-stakes call in this whole spec.
2. **GitHub Copilot and xAI's account door** (§7) require a new `HarnessAuthKind` (or two),
   a `packages/shared/src/harnesses.ts` edit, and a decision about which harness(es) accept a
   Copilot/xAI-backed model (neither has a natural 1:1 harness the way Claude/Codex do — most
   likely an OpenAI-compatible-shaped route into OpenCode/Pi, per §7's Copilot row). Not resolved
   here; flagged as Phase 2, explicitly blocked on `harnesses.ts` settling (currently being
   edited by another agent, §0) and on this decision.
3. **Whether `resolveClaudeCredential` (§5.2) should ever gain a real refresh path.** Contingent
   on whether Anthropic's own OAuth token format (as opposed to `setup-token`'s static-looking
   output) is ever adopted — itself contingent on decision #1. If #1 stays permanently off,
   `credentials/claude.ts` never needs a refresh branch at all and Tier A (expiry-tracking-only)
   is the permanent shape, not an interim one.
4. **Route the `/oauth-credentials/*` rename (§6.3) or keep `/oauth/*`?** This document
   recommends the rename (clarity — `oauth` alone conflated "the CLI's own OAuth client role"
   with "credential storage") but it is a naming call with real migration cost (compatibility
   alias window, §10.2 Step 6) — confirm before Step 3 starts, since reverting the name after
   client code (CLI, web) has shipped against it is a second breaking change.
5. **Probe-cost caching for `credentials/api-key.ts`'s liveness checks (§4).** This document
   recommends live-check-on-every-read (matching Codex's existing pattern) and explicitly
   recommends **against** adding a `project_secrets` status-cache column pre-emptively. If a
   real performance problem shows up (a provider's liveness probe being slow/rate-limited),
   revisit with actual numbers rather than speculative caching — owner sign-off needed only if
   that becomes necessary, not before.
