# Changelog

All notable changes to `@kortix/sdk` are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Changed (internal restructure, KRTX-2729)
- `PATH_PROXY_URL_REGEX` is no longer exported from `@kortix/sdk` (dead import
  path; the constant lives in `packages/sdk/src/core/session/url.ts`).
- `buildRuntimeRequest` is no longer exported from `@kortix/sdk` (dead import
  path; internal to `packages/sdk/src/core/runtime/runtime-rest-client.ts`).
- `hasLocalhostUrls` and `__getConfigResolver` keep their exports: the merge
  gate holds any removal of a snapshot-tracked public name (G4), so deleting
  the dead code is deferred to a surface-removal decision.

### Added (session-log restore notice)
- `sessionLogRestoreNotice(session)` (`SessionLogRestoreNotice`): what a partial
  restore of a session log could not bring back, from the session record
  (`restore_grade: 'partial'`, `grade_counts`, `ext.kortix.data.restore`).
  `missing[].kind` includes `'message'`: the log was over the API's restore cap
  (`SESSION_LOG_RESTORE_MAX_BYTES`), so the agent got none of those earlier
  messages; the transcript keeps them.

### Changed (Enterprise is a feature layer; trials removed)
- `AccountState.enterprise` (`AccountEnterprise`, additive): `{ state: 'off' | 'demo' | 'licensed' }`.
  Demo is self-serve (owners and admins); Licensed is a license contract.
- `getEnterpriseDemo` / `setEnterpriseDemo` call `GET`/`PUT
  /accounts/:id/iam/enterprise-demo` again (they rejected with
  `ENDPOINT_RETIRED`). New hook `useSetEnterpriseDemo()`.
- `contactEnterpriseSales(params)` (`POST /billing/enterprise/contact`),
  `kortix.billing.contactSales`, `useContactSales()`: one-click "Talk to sales".
- `AccountState.trial` is always null (`@deprecated`): trials are removed.
- `AccountContract.credits_usd` / `AccountEnterpriseOffer.credits_usd` are
  optional and `@deprecated`: a license carries no credits.

### Added (BYOK fee entitlement)
- `ADMIN_OVERRIDE_KEYS` and `ADMIN_ENTITLEMENT_OVERRIDE_KEYS` add `'byokFee'`
  (additive union member): the BYOK platform fee is an entitlement, on by
  default for Free and Credits, off on Enterprise, and an operator override
  switches it per account.

### Changed (Enterprise is a feature layer)
- An Enterprise trial no longer sets `AccountState.plan` to Enterprise: `plan`
  stays the billing plan (what the account pays for), and the trial lends the
  Enterprise features only (`trial.plan === 'enterprise'`, `tier.entitlements`).
  A Credits trial still overlays `plan`. `plan.family === 'enterprise'` now
  means an Enterprise contract.
- `AccountState.subscription.monthly_usd` (optional, additive): the credits
  plan's monthly amount the account pays, kept during a trial.

### Added (Enterprise contracts and trials)
One plan system (2026-10-15): the plan decides features; a trial is a dated
grant of a plan; Enterprise is an annual contract (license + credit pool).

- `AccountState` adds optional `trial` (`AccountTrial`: `plan`, `ends_at`,
  `days_left`), `contract` (`AccountContract`), `enterprise_offer`
  (`AccountEnterpriseOffer`) and `grace` (`AccountAccessGrace`: SSO/SCIM kept
  14 days after an Enterprise trial or contract ends). Absent on an older
  server. Additive.
- `acceptEnterpriseOffer(params)` (`POST /billing/enterprise-offer/checkout`),
  `kortix.billing.acceptEnterpriseOffer` and `useAcceptEnterpriseOffer()`:
  a Stripe Checkout link for the open offer. Needs `billing.write`, which owners
  AND admins now hold. Additive.
- Admin: `useAdminEnterpriseContracts`, `useAdminCreateEnterpriseContract`,
  `useAdminEndEnterpriseContract`, `useAdminWithdrawEnterpriseOffer`,
  `useAdminEnterpriseOfferLink`, types `AdminEnterpriseContract`,
  `AdminAccountContract`, `AdminContractCollection`,
  `AdminCreateEnterpriseContractVariables`, and `ADMIN_ENTITLEMENT_OVERRIDE_KEYS`
  (the six override keys the server accepts). `AdminAccount` adds optional
  `contract` and `graceEndsAt`. Additive.

### Deprecated (Enterprise preview and flags)
- `getEnterpriseDemo`, `setEnterpriseDemo`, `useAdminSetEnterpriseDemo`,
  `useAdminSetEnterpriseEntitled`, `useAdminSetManagedModels` now reject with
  `ENDPOINT_RETIRED` and send no request (the API answers 410). Grant an
  Enterprise trial (`useAdminGrantTrial`), create a contract, or set the
  `managedModels` override. Removed in the next major. No export was removed.
- Type changes (the API no longer sends these fields): `AdminAccount`
  `managedModelsOverride`, `demoEnterprise`, `enterpriseEntitled` and
  `computeRateMultiplier` become optional and `@deprecated`;
  `AdminAccountTrial.monthlyUsd` becomes optional and `@deprecated`;
  `AccountState.enterprise_entitled` is `@deprecated` (read `plan.family`).

### Changed (credits-only billing)
Seat pricing is gone. Every legacy plan reads as `credits`: one paid plan, any
whole monthly amount from $50 to $10,000, one shared credit wallet, unlimited
members. 1 credit = $0.01.

- Added: `setBillingPlan(params)` (`POST /v1/billing/plan`), `kortix.billing.setPlan`,
  and the `useSetBillingPlan()` mutation hook in `@kortix/sdk/react`. Params
  `{ monthlyUsd, successUrl, cancelUrl, locale?, accountId? }`; result
  `SetBillingPlanResult` = `checkout_created` | `updated` | `unchanged` |
  `payment_pending`. The hook invalidates the `['account-state']` queries.
  Types `SetBillingPlanParams` and `SetBillingPlanResult`. Additive.
- Deprecated, now reject with `ENDPOINT_RETIRED` and send no request (the API
  answers `410`): `createPerSeatCheckout`, `claimPerSeatBilling`,
  `cancelScheduledChange` (also `kortix.billing.subscription.cancelScheduledChange`),
  `getProrationPreview` (also `...subscription.prorationPreview`). Their result
  types stay exported. Removed in the next major. No export name was removed.
- Breaking type changes (the API no longer sends these fields; nothing is
  renamed):
  - `PlanFamily` is `'free' | 'credits' | 'enterprise'` (`'team'` is gone).
  - `AccountState.plan`: `status` is `'current' | 'non_plan'`, `shape` is
    `'none' | 'credits' | 'contract'`, `is_grandfathered` is removed, and
    `monthly_usd: number | null` is added.
  - `AccountState` drops `billing_model`, `seats`, `member_count`,
    `can_claim_per_seat` and `can_claim_computer`. `usage_this_period` is
    present for every account.
  - `ResolvedPlanView.isGrandfathered` is replaced by `monthlyUsd`.
  - `BillingTierConfigurationsResponse` adds required `min_monthly_usd` and
    `max_monthly_usd`.
  - Admin: `AdminGrantTrialVariables.seats` is removed (`creditGrant` is granted
    now and every 30 days during the trial); `AdminAccountTrial.seats` becomes
    `monthlyUsd`; `AdminAccount` drops `billingModel` and `seatCount`;
    `AdminAccountPlan` drops `is_grandfathered`, adds `monthlyUsd`, and its
    `family` and `status` unions narrow as above.
- The 402 body no longer carries `billing_model`. Branch on `billing_state`
  (`out_of_credits`, `no_subscription`, `payment_failed`).
- Added: `ProjectLlmCatalogResponse.platformFeePercent`, Kortix's fee on managed
  model usage in percent (5.5). `managedPricingRoutes` now carries base provider
  prices, before the fee. Optional, absent on an older server. Additive.
- Changed: `COST_MARKUP` is `1.055` (was `1.2`), so displayed session cost
  matches what credits are charged.

### Added (session-log follow-ups)
- `sessionLogFullTextPlan(refs)`: which texts stored by reference a host shows
  inline and which it downloads. The smallest fill the 1 MiB inline budget;
  only the rest download. Before, a host could only download every text of a
  turn over 1 MiB in all.
- `hasRuntimeConfirmedMessage(sessionID, messageID)`
  (`@kortix/sdk/internal/sync-store`): the store holds the message from a
  runtime read or a live event, not only from a saved copy.

### Fixed (session-log follow-ups)
- `useSessionSync` stops offering the saved copy's older pages once the
  runtime holds the saved window's oldest message and has no older page of
  its own: `hasOlder` is `false` when the whole history is loaded. Before,
  the "earlier messages" control stayed after the runtime had answered
  everything (web and mobile). A box that lost its state still pages its
  saved history.
- `toToolView` reads Claude Code edits: `old_string` / `new_string`, the
  `edits[]` of a `MultiEdit` (blocks joined in order), and a `NotebookEdit`'s
  `notebook_path` and `new_source`. `toolKind` maps `MultiEdit` and
  `NotebookEdit` to `edit`; `inputPath` reads `notebook_path`. The
  `file-edit` view model reads the same blocks.
- Unchanged message arrays keep their rows past 20 sessions
  (`buildSessionMessages`). This stops the "Maximum update depth exceeded"
  in a host that reads more than 20 sessions per render (the web session
  context modal with 20+ sub-agents).

### Added (block readers a host draws a tool call with)
- `toolCallStatus(call)` (`pending` / `running` / `completed` / `error`),
  `toolCallRawOutput(call)` (a completed call's text, one string per call
  object) and `toolCallError(call)` (a failed call's error: the semantic
  error, else the result text, as `toV1` gives `state.error`, so a native
  failed call never shows an empty error body).
- `subAgentCalls(thread)`: the shown tool calls of a sub-agent thread's
  replies, in order, one array per thread object.

### Changed (session log)
- `useSession({ chatEngine: false })` negotiates the session log (v2) as
  `useSession` with its chat engine does: with the runtime's
  `session.log.v2` and the project flag `session_log`, it reads the first
  log page and switches the session stream to `schema=v2`, so
  `useSessionLogThread` serves v2 records to a host that reads its own
  transcript (apps/mobile).
- `useSessionLogThread` on v2 places the v1 store rows the log lacks by time,
  as `useSessionMessages` does: an older page (`loadOlder`) goes before the
  log's messages, an optimistic send after them. Before, every such row was
  appended, so older turns rendered after the newest one.

### Changed (one saved-history read per session open)
- `useSession` reads a session's saved copy once per open. The session-open
  snapshot carries the first window; the read waits up to 2 s for a snapshot
  in flight, then asks `GET …/transcript?shape=sync&history=true`. Before,
  every open with a snapshot in flight downloaded the window twice, and the
  sync layer could read it a third time (KRTX-189).
- `useSessionSync` with no `mirror` runs the same read. `useSession` passes
  its answer as `mirror`: the copy, or `null` while the read runs and when
  the server holds none. A host that mounts a second `useSessionSync` for the
  root conversation beside `useSession` passes `mirror: null`. Beside
  `useSession({ chatEngine: false })`, which makes no saved-history read, and
  on a `savedChild` hook, the host omits `mirror`: that hook makes the read.
- A host that passes no `mirror` now gets the server's "no saved copy" answer
  from the snapshot too, so the device copy is dropped for the next open, as
  the route answer already did.

### Added (saved copy before `useSession` binds)
- `readSavedSessionCopy({ projectId, sessionId, runtimeSessionId })` and
  `SavedSessionCopy` (`{ envelope, empty }`): the same saved-history read,
  plus the empty-conversation proof (`isEmptyConversation` over the turn
  record, read only when the copy proves the root empty). Never throws. For a
  connecting screen that shows the conversation while the computer wakes;
  apps/mobile uses it. Additive (KRTX-189).
- The open that follows `readSavedSessionCopy` downloads the window no second
  time. The SDK holds the copy for up to 5 min (one wake). The session-open
  snapshot then asks for the pointer only (`?transcript=0`), and the
  saved-history read answers from the held copy. Before, the connecting view
  and the thread after it each downloaded the window.
  `resetIdentityState` forgets the held copy and the session-open snapshots
  (KRTX-189).

### Added (bounded review reads)
- `getReviewSummary(projectId)` and `project(id).review.summary()`
  (`GET /v1/projects/:p/review/summary`): `ReviewSummary`, the needs-you
  counts of the review inbox, `{ needs_you_total, needs_you_by_session }`.
  Read it for a badge or a per-session indicator instead of the list. A
  connector call the caller may not resolve counts nowhere. Additive
  (KRTX-2316).
- `listReviewItems` takes `sessionId`, `limit` and `cursor`
  (`ReviewItemsQuery`) and resolves to `ReviewItemsPage`, which adds
  `next_cursor` (null on the last page). The server now returns one page:
  50 items by default, at most 200, with Needs you first, then Waiting, then
  Done, newest first within each. A caller that read the whole inbox from one
  response pages with `cursor` or passes `segment`. Additive types.
- `listChangeRequests` takes `cursor` and its response adds `next_cursor`.
  The server now returns one page: 50 change requests by default, at most
  500 (a larger `limit` answers 400, it no longer clamps). Additive types.
  `project(id).changeRequests.list(status?, options?)` passes both through,
  so the facade can page as well. Additive (a widened parameter list).
- React (`@kortix/sdk/react`): `useReviewSummary(projectId)` (polls every
  60 s), `useReviewItemPages(projectId, query)` (an infinite query; read the
  rows with `reviewItemsOf(query.data)`), `nextReviewItemsCursor`, and the
  keys `qk.project.reviewSummary`, `qk.project.reviewItemsScope` and
  `qk.project.reviewItemPages`. Additive.

### Added (who may decide an approval)
- `SessionAuditAction.can_resolve`: true only on an unresolved connector call
  the viewer may approve or deny, the verdict `resolveApproval` would get
  (today a project manager, or the session's launcher unless an API token or a
  service account started the session). False on every other
  row. Show Approve / Deny only when it is true. Also on the session snapshot's
  `audit` leg. Optional, absent on an older server. Additive (KRTX-1724).
- `ApiReviewItem.can_resolve` (connector-call items) and
  `ReviewApprovalAction.canResolve`, set by `mapApiReviewItem`. A viewer who
  may not decide the call gets it with status `waiting`, not `needs_you`. On an
  older server `canResolve` follows `args_preview_authorized`, which the same
  rule decided. Additive.
- `reviewVerdictAllowed` refuses approve and reject on a connector call whose
  `canResolve` is false.
- `SessionAuditAction.resolvers`, `ApiReviewItem.resolvers` and
  `ReviewApprovalAction.resolvers` (set by `mapApiReviewItem`): who decides a
  pending call, for a viewer whose `can_resolve` is false. `managers` for a
  session started with an API token or a service account (`origin: 'backend'`),
  else `managers_and_launcher`. Null on a settled audit row; optional, absent
  on an older server. Additive (KRTX-1724).

### Added (undecryptable stored values)
- `ProjectSecret.status` and `AccountSecretResource.status`: `'ok'`, or
  `'undecryptable'` when the server can no longer decrypt the stored value
  (its encryption key changed, or the row is damaged). The value is lost;
  re-enter it with `upsertProjectSecret` or `rotateAccountSecretResource`.
  `ProjectSecret.status` reports the shared value and is absent when none is
  set. `ProjectSecret.mine.status` reports the caller's own override, which
  the caller's sessions read while it is active: set it again with
  `setPersonalProjectSecret`, or remove it with `deletePersonalProjectSecret`.
  `SecretValueStatus` is the new public type. Optional: absent on older
  servers. A connector call on such a credential fails with
  `ConnectorCallError.code === 'credential_undecryptable'`. Any other request
  that needs such a value answers `409` with
  `ApiError.code === 'SECRET_UNDECRYPTABLE'` and a message that names it.
  Additive (KRTX-1719).

### Added (session restore)
- `restoreProjectSession(projectId, sessionId)` and `session.restore()`
  (`POST /v1/projects/:p/sessions/:s/restore`) take a deleted session out of
  the trash. Its messages, stored files and branch come back, and its next
  start boots a fresh sandbox from the branch. A refusal rejects with an
  `ApiError`: 409 `session_not_deleted`, 409 `session_sandbox_removal_pending`
  (retry in a minute), 410 `session_purged`. Additive (KRTX-1734).
- `deleteProjectSession` resolves to `{ ok, restore_until? }`: the last
  instant the session can be restored, 30 days after the delete. Absent on an
  API that predates restore. Additive.

### Added (gateway budget meters per period)
- `GatewayBudgetRow` has `spent_usd`, `period_start` and `resets_at`: the
  spend in the budget's own period (day, week or month, UTC), the number the
  gateway compares with `limit_usd` before it admits a request, and when that
  period ends. A member budget counts its member's requests only. Use
  `spent_usd` for a budget meter, not `project_spend.cost`, which is
  month-to-date. Optional, absent on an older server. Additive (KRTX-1725).
- `GatewayBudgetRow.subject_email`: the member's email for a member budget,
  also when the member has no spend this month and so no entry in `members`.
  `null` for a project budget. Optional, absent on an older server. Additive.

### Added (permissions)
- `PROJECT_ACTIONS` and `ProjectAction`: every project action the IAM engine
  answers about, the same strings as the API's catalog
  (`apps/api/src/iam/actions.ts`; a test fails when they differ). Pass them to
  `useCan` / `useCans` instead of spelling a leaf by hand (KRTX-1720).
- `TRIGGER_CONTROL_ACTIONS`, `triggerControlsFrom(cans)` and `TriggerControls`:
  the trigger controls a viewer gets, from the leaves each trigger route
  asserts: create, update and delete need `project.write` and their trigger
  leaf, fire needs `project.trigger.fire`. An unresolved probe gives no
  control. Web and mobile both read them.
- `REVIEW_CONTROL_ACTIONS`, `changeRequestControlsFrom(cans)` and
  `ChangeRequestControls`: open a change request needs `project.write` +
  `project.gitops.push`, merge needs `project.write` + `project.gitops.merge`,
  close and reopen need `project.write`.
- `reviewVerdictAllowed(item, verdict, cans)`: whether to offer a verdict on a
  review item. Approving a change request merges it (`canMerge`); every other
  change request and native verdict needs `project.write` +
  `project.review.act`. A connector call offers approve and reject only, to
  the viewer the API lets decide it (`previewAuthorized` is not `false`). Web
  and mobile both read it.
- `canManageBilling(state)` and `canOfferTopup(state)`: whether the caller may
  change billing, and whether to offer buying credits or auto top-up (the plan
  may buy credits AND the caller may change billing). Both return `false` while
  the account state is unknown. Additive.

### Added (connector credential re-sync)
- `setConnectorCredential` now resolves to `{ ok, sync? }`. For an MCP
  connector the server re-reads the tools after the write: `sync` is that run
  (`ConnectorSyncResult`), and a per-slug entry in `sync.errors` means the
  credential is stored but the tools still fail to load. Absent for other
  providers and on older servers. Additive (KRTX-2185).

### Added (session log reads, P5.5)
- `getSessionLogPage(projectId, sessionId, query?)` and `session.log(query?)`
  read one page of the stored session log (`GET /v1/projects/:p/sessions/:s/log`):
  `SessionLogPage` for `{ thread?, before_seq?, limit? }` (`SessionLogPageQuery`),
  `null` on a 404 (no stored log, or no such thread). `SessionLogPage` and
  `SessionLogPageQuery` are now public types. Additive.
- `classifySessionLogMessage(message)`: `classifyTurn` of a session-log message
  (`ClassifiedPart`s from its blocks, its `TurnError`). Transitional: it goes with
  `ClassifiedPart`. Additive.
- `findSessionAttachments` also reads session-log records: attachment blocks, a
  harness block's v1 file part, text blocks and `show` tool-call blocks. Additive.

### Added (session readiness)
- `session.ensureReady({ session })` takes the session's row when the caller
  already read it. A `running` row that names its sandbox and
  `runtime_session_id` is adopted without `POST /start`; any other row, or a row
  of another session, falls through to `/start` as before. The Kortix CLI
  passes it, so a one-shot `kortix sessions chat -p` on a running session saves
  the 1.2–2.4 s `/start` round trip. Additive.

### Added (SSO and MFA remedies)
- `configureKortix({ onAccessRemedy })` / `createKortix({ onAccessRemedy })`:
  called with `'sso_required'` or `'account_mfa_required'` when the API answers
  403 with that code, for every REST client (`backendApi`) response, including
  `showErrors: false` calls. The runtime proxy and the event stream do not call it.
  A host without DOM events (React Native) cannot receive the
  `kortix:sso-required` / `kortix:mfa-required` window events; this is its
  signal. A throw from the hook is caught. The window events are unchanged.
  Additive (KRTX-1716).

### Added (account invites)
- `acceptAccountInviteAndLand(inviteId, invite?)` (`accountInvites.acceptAndLand`)
  accepts an invite and returns `{ accepted, landing }`. `accountInviteLanding`
  is the rule alone, and `AccountInviteLanding` its type: the first project the
  accept granted, else the first project `invite` names, else the account
  joined. Web and mobile land through it (KRTX-1731). Additive.

### Added (files)
- `listProjectDirectory(projectId, { cursor?, limit? })` and
  `files.listDirectory({ cursor?, limit? })` page a folder: `limit` entries
  (1 to 2,000, default 500), and `ProjectDirectoryListing.next_cursor` while
  entries remain. Every page reads the commit the first page read, so a push
  between pages skips or repeats nothing. Additive: a call without `cursor`
  or `limit` sends the same request as before (up to 5,000 entries), and a
  server that predates paging omits `next_cursor`.

### Added (presence)
- `useSession().presenceAwake` (`{ until: Date; capAt: Date } | null`): with
  `browserPresence`, when the session's sandbox stops after the latest
  presence renewal, and the time presence cannot keep it on past. The view
  re-sends present every 5 minutes while the person is present, when a turn
  ends, when the control plane closes a turn, and when the sandbox becomes
  ready, to read it again. A turn that starts, or a sandbox that stops,
  clears it. `session.presence()` types its response body:
  `{ ok, awake_until?, awake_cap_at? }`. Additive: a server that predates it
  omits both fields, and `presenceAwake` stays `null`.

### Added (display)
- `AppDisplay` (`listed`, `preview`: `live` | `none`, `parent`): where Kortix
  shows an App. `App.display` reads it; `UpdateAppInput.display` replaces it
  whole (`{}` restores the defaults). Presentation only. Additive: a server
  that predates it omits the field.

### Removed
- Apps have no monthly budget. `App.monthly_budget_usd`,
  `CreateAppInput.monthly_budget_usd` and `UpdateAppInput.monthly_budget_usd`
  are gone: account credits pay for App compute, and the billing `402` is the
  only cost gate. A server that still sends the field is ignored; a client
  that still sends it gets `200` and the server ignores it.
- The unreleased `convex` App kind is gone before any release carried it
  (0.13.53, the last published version, has none of these names): `AppKind`,
  `App.kind`, `App.instance` and the `AppInstance*` types, `AppSnapshot*`,
  `AppCredentials`, `DeleteAppOptions`, `DeleteAppResult`, `GetAppLogOptions`,
  `WaitForAppOptions`, `getAppCredentials`, `rotateAppCredentials`,
  `listAppSnapshots`, `createAppSnapshot`, `deleteAppSnapshot`,
  `restoreAppSnapshot`, `getAppLog`, `waitForApp`, `useAppSnapshots`,
  `appSnapshotsKey`, and the `'convex'` source kind. A Convex backend is now an
  ordinary server App with a volume (the `convex` template of
  `kortix apps launch`). No published name is removed.

### Added
- Apps: releases, machines, volumes.
  `CreateAppBuildInput.config` (`AppReleaseConfigInput`) carries a release's
  config: `processes`, `http_service`, `services`, `mounts`, `vm`, `deploy`
  (`strategy`, `release_command`). An invalid config answers
  `400 app_config_invalid` with `issues`. `UpdateAppInput.labels` replaces an
  App's labels. `App` gains `capabilities` (`AppCapability`), `labels`,
  `scale`, `services` (`AppServiceSummary[]`, each with its URL), `machines`
  (`total`, `running`, `stopped`), `volumes` (`count`, `size_gb`), `config`
  (the live release's `AppReleaseConfig`), `uses`, `used_by`, `auth`
  (`AppAuth`), `always_on`, `hosting_type`, `estimated_monthly_usd` (each
  group's `vm` × its scale, 24/7), `retained_deployments`, and `warnings`.
  Machines: `listAppMachines`, `startAppMachine`, `stopAppMachine`,
  `restartAppMachine`, `destroyAppMachine`, `scaleApp` (0-20 machines per
  process group), `execInApp` (project admins). Volumes: `listAppVolumes`,
  `createAppVolume`, `updateAppVolume` (grow, retention), `destroyAppVolume`
  (`confirmName`), `listAppVolumeSnapshots`, `createAppVolumeSnapshot`,
  `restoreAppVolume`, `forkAppVolume`. Sign-in: `createAppToken` (capability
  `member_tokens`). Facade: `project(pid).apps.{machines.{list, start, stop,
  restart, destroy}, scale, exec, volumes.{list, create, update, destroy,
  snapshots, snapshot, restore, fork}, token}`. Types: `AppMachine`,
  `AppMachineState`, `AppVolume`, `AppVolumeSnapshot`, `AppExecInput`,
  `AppExecResult`, `CreateAppVolumeInput`, `AppReleaseConfig`,
  `AppReleaseConfigInput`, `AppServiceConfig`, `AppServiceAccess`,
  `AppAutoStop`, `AppCheck`, `AppMountConfig`, `AppVmConfig`,
  `AppDeployStrategy`, `AppServiceSummary`, `AppCapability`, `AppAuth`,
  `AppToken`, `CreateAppBuildInput`.
- `@kortix/sdk/react`: `useAppMachines(projectId, appId)` (5 s poll; `start`,
  `stop`, `restart`, `destroy`, `scale`), `useAppVolumes(projectId, appId)`
  (`snapshot`, `restore`, `fork`, `extend`, `destroy`),
  `useAppVolumeSnapshots(projectId, appId, volumeId)`, `useAppDeployment`,
  and the keys `appMachinesKey`, `appVolumesKey`, plus
  `qk.project.appMachines`, `qk.project.appVolumes`,
  `qk.project.appVolumeSnapshots`.
- `FeatureFlagKey` gains `notification_center` (also in `FEATURE_FLAG_KEYS`
  and `KortixProject.experimental`). Off by default. It gates the KRTX-1742
  notification entries below per project. Turn it on with
  `updateFeatureFlag(projectId, 'notification_center', true)`.
- Notifications (KRTX-1742), behind the `notification_center` project flag,
  off by default. While it is off, the server writes no inbox row and sends
  no Web Push and no email for that project, and the session watch routes
  answer `403` `feature_disabled`. The caller's inbox: `listNotifications({ limit?,
  before? })` → `InboxNotificationPage` (`notifications`, `unread_count`,
  `next_before`) and `markNotificationsRead({ ids } | { all: true } |
  { sessionId })`. Push and email choices per kind:
  `getNotificationPreferences()` and `updateNotificationPreferences(patch)` →
  `NotificationPreferences` (`kinds`, `email_available`). Web Push:
  `getWebPushPublicKey()`, `registerWebPushSubscription({ endpoint, keys })`,
  `unregisterWebPushSubscription(endpoint)`. Session watch:
  `getSessionWatch(projectId, sessionId)` and `setSessionWatch(projectId,
  sessionId, watching)`, also `session(pid, sid).watch()` and `.setWatch()`.
  Facade: `kortix.notifications.{list, markRead, preferences,
  updatePreferences, webPushPublicKey, registerWebPushSubscription,
  unregisterWebPushSubscription}`. Types: `InboxNotification`,
  `InboxNotificationKind`, `InboxNotificationPage`, `NotificationPreferences`,
  `NotificationPreferencesPatch`, `WebPushSubscriptionInput`. Constants:
  `INBOX_NOTIFICATION_KINDS`, `DEFAULT_NOTIFICATION_PREFERENCES`.
- `@kortix/sdk/react`: `useNotificationInbox({ userId, limit?, enabled? })`
  (60 s poll while visible, `unreadCount`, optimistic `markRead`,
  `markAllRead`, `markSessionRead`), `useNotificationPreferences({ userId })`
  (optimistic `update`), `useSessionWatch({ userId, projectId, sessionId })`
  (optimistic `setWatching`), `notificationInboxQueryOptions`, and the
  `qk.notifications` key family (`scope`, `inbox`, `preferences`,
  `sessionWatch`, keyed by user). Each hook takes `enabled`; a host passes
  `useFeatureFlag(projectId, 'notification_center').enabled`.
- `session(pid, sid).presence()` accepts `alerts?: boolean`, and
  `useSession({ presenceAlerts })` sends it: with `notification_center` on,
  the server skips the phone and Web Push only while an alerting tab is in
  use. A change is sent at once, without dropping the lease. A second
  argument `{ keepalive?: boolean }` lets the request outlive a closing page;
  default on for an absent report, off for a present one.
- `useSession({ presencePageExit })`, default `false`: `pagehide` reports
  absent, and every absent report is sent with `keepalive`, so a closed tab
  ends its lease at once. Off is the presence from before: no `pagehide`
  report and no `keepalive`. A closing tab still turns hidden and reports
  absent, but the browser can cancel that request as the page unloads, and
  the lease then lives to its 90 s expiry. Pass the project's
  `notification_center` flag. A change applies without a new presence
  report.
- `ConnectorPageLimitError` (`code: 'max_pages_exceeded'`, `connector`,
  `action`, `maxPages`, `nextArgs`): `paginateConnector` and
  `connector(slug).paginate` throw it when `maxPages` (default 100) ends a
  cursor that still has pages. Resume with `nextArgs`. A capped listing no
  longer completes as if it were whole.
- `ChannelBinding` gains optional `channelUnavailable`: Slack answered that the
  conversation is deleted or out of the bot's reach. Slack bindings now carry
  `channelName` (a channel without `#`, the other person's name for a DM, the
  members for a group DM) and `channelType` (`channel` | `private_channel` |
  `im` | `mpim`). Absent on older servers.
- `configureKortix({ eventStreamTransport })`: how the live event stream's bytes
  arrive, for a host whose `fetch` cannot stream a response body. The SDK calls
  it once per connection with `{ url, headers, signal }` (auth headers
  included); it yields `{ data?, id?, retry? }` messages, returns when the
  server ends the stream and throws when the connection fails. Reconnect,
  `Last-Event-ID` resume, backoff, heartbeat and coalescing stay in the SDK.
  Types: `RuntimeEventTransport`, `RuntimeEventMessage`.
- `notifyHostSignal('visible' | 'online' | 'retry')`: a host without
  `visibilitychange`/`online` events (React Native) reports the same facts.
  The SDK re-reads the transcript tail, revives a parked stream, and opens a
  fresh connection (`visible`/`online` only after 60 s without a frame;
  `retry` always). Type: `HostSignal`.
- `subscribeRuntimeStream(listener)` (`@kortix/sdk/react`): observe the live
  stream for host side effects. Signals: `{ type: 'event', event }` after the
  SDK applied the event, and `connecting`, `open`, `lost`, `parked`, `closed`.
  Type: `RuntimeStreamSignal`.
- `openEventStream({ onConnectionChange })`: `connecting`, `open` (first frame
  of an attempt), `lost`. Type: `EventStreamConnectionState`.
- `sessionModelPin(session)`: the `provider/model` a session is pinned to, or
  null. `setProjectSessionModel` sends the pin as `model` and keeps the pre-W4
  `opencode_model` key for an older API.
- `isRuntimeNotReadyResponse(error)`: true for the daemon's 503 while the
  session runtime cannot take a request, on both harnesses. It matches the
  `code: "runtime_not_ready"` a current daemon sends and the two `error` texts
  of an older one (`sandbox runtime not ready`, `opencode not ready`).
  `RUNTIME_NOT_READY_MARKERS` lists the same three spellings as lower-case
  substrings, for a host that needs a string list (a telemetry ignore list).
- `isRuntimeStartingError(error)`: the answer above, plus a sandbox that is
  not ready and a runtime URL that is not pinned yet. An error boundary
  retries on it instead of showing a crash.
- `resetRuntimeQueries(queryClient)` (`@kortix/sdk/react`): drops every cached
  runtime query. Call it after the session's runtime is replaced (a restart, a
  config reload).
- `runtimeKeys.sessionTodo(sessionId)`: the todo-list cache key.
- `isStepPart(part)`: true for `step-start` and `step-finish` parts.
- `useSession` option `initialRuntimeSessionId`, and `runtimeSessionId` on the
  `useSessionMessages` source.
- `modelRefToKey(ref, gatewayEnabled)`: one parser for a stored model ref
  (session pin, channel binding, trigger, agent `model`). Gateway on, `kortix/x`
  and `x` both name the gateway model `x`; gateway off, the ref splits on its
  first `/` into the native provider and model.
- `ModelOption` (`FlatModel` plus `id`, the ref a pick stores and sends).
  `flattenModels` returns it.
- `AgentConfigResponse` gains optional `harness` (the harness a new session of
  the project runs) and `ignored_settings` (the `behavior` settings it does
  not apply).
- `RuntimeCapability` gains `session.config`: the runtime serves a config
  document (`/global/config`). OpenCode does; pi does not.
- One tool taxonomy: `toolKind(name)` returns a `ToolKind` (`read`, `edit`,
  `bash`, `web_search`, `task`, `question`, …) for any harness's tool name,
  including pi's and the `oc-`/`oc_`/dashed spellings. Narration families,
  `toolViewModel`, `getToolInfo`, `toolInfo` categories and the context-tool
  group all derive from it. `inputPath(input)` reads a file tool's path
  (`filePath`, `file_path` or pi's `path`).
- `ToolView` gains optional `kind`, `files` (`ToolFile[]`: path, type,
  before/after, unified patch, line counts), `diff`, `diagnostics`, `answers`
  and `childSessionId`, filled from whichever fields the harness sent;
  `toToolView(part)` builds one from a tool part. `toolViewModel` renders
  pi's `edits[]` as a file-edit diff.
- The conversation tree of a project session: `runtimeSessionsOf`,
  `rootRuntimeSession`, `directSubsessions` and `projectSessionForRuntimeId`
  read `runtime_sessions`/`runtime_session_id` first and fall back to the
  pre-W4 names.
- The Kortix transcript format, `kortix.transcript.v1`
  (`KORTIX_TRANSCRIPT_SCHEMA`): `KortixMessage` (`{ info, parts }`),
  `KortixMessageInfo`, the `KortixPart` union and its 12 part types, the
  message errors (`KortixMessageError`, each with an optional `code`),
  `KortixSessionEvent` (the 14 session events, including
  `message.part.delta`), `RuntimeQuestion`, `RuntimeQuestionRequest`,
  `RuntimePermissionRequest`, `RUNTIME_PERMISSION_REPLIES`,
  `RUNTIME_PERMISSION_CAPABILITIES`, `TURN_ERROR_CODES` and `isTurnErrorCode`.
  They keep OpenCode 1.18's field names, so every value a runtime sends
  today is valid. `Message`, `Part`, `TextPart`, `ToolPart`, `SessionStatus`,
  `PermissionRequest`, `QuestionRequest` and the other transcript names this
  package published before are now aliases of these types.
- Session verbs on a session handle: `messages({ conversationId, limit,
  before, signal })` reads a page of the transcript from the daemon's Kortix
  route (`/kortix/runtime/messages`), `pending()` returns the conversation
  statuses with the waiting permission requests and questions,
  `answerPermission(id, reply, message?)`, `answerQuestion(id, answers | null)`
  and `compact(model?)` (resolves with the model used; an `ApiError` with code
  `MODEL_REQUIRED` when no model is known). New types `TranscriptPage`,
  `PendingInteractions`, `RuntimeVerbs`, `RuntimeResult`,
  `RuntimeRequestOptions`, `RuntimeEventStreamOptions`.
- `openEventStream({ url })`: stream a runtime by its URL.
- `TeamsInstallation` gains optional `appVersion` (the Teams app version the
  org catalog serves, or `null` when no publish recorded it),
  `latestAppVersion` (the version the server publishes), and
  `appUpdateAvailable` (the org catalog serves an older app, or one with no
  recorded version, so a Teams admin should publish the update). Absent on
  older servers.
- Computers are connector accounts. `addComputerToProject(projectId,
  { tunnelId, share })` (`POST /projects/:id/computers`), the facade's
  `project(id).connectors.connections.addComputer`, and
  `useAddComputerToProject` add a machine the caller already paired to a
  project as an account of its `computer` connector: private (`share: 'me'`,
  the default) or shared with the project (`'project'`). `Connection` gains
  optional `tunnel_id` and `machine` (`online`, `last_heartbeat_at`,
  `hostname`, `platform`), set on `computer` accounts only.
- `Connection.machine` gains optional `access` (`{ mode: 'ask' | 'always' |
  'off', granted_until }` or `null`): who may use the machine, as its owner
  set it on the computer. `null` or absent for agents that never report it.
- A paired computer follows its owner: their private account exists in every
  project they belong to without a call. `addComputerToProject` with
  `share: 'me'` stays accepted but is no longer needed; `share: 'project'` is
  how a machine is shared with a project. `useApproveDeviceAuth` needs no
  `projectId` on current servers, and its `connectionId` is `null` when the
  approval named no project.
- `useApproveDeviceAuth` accepts optional `projectId` and `share`, sent as
  `project_id` and `share`, and returns the created account's optional
  `connectionId`; `DeviceAuthInfo` gains optional `projectId`;
  `TunnelConnection` gains optional `ownerUserId`.
- `useTunnelConnections` accepts an optional `{ refetchInterval }` (default
  5 s; `false` stops polling).
- The wire message-id clock is public: `mintWireMessageIdAbove` (mint above a
  known floor clock, with an optional `backdateMs`), `newestWireIdClock`,
  `wireIdClock`, `wireIdClockAt`, `isWireIdAheadOf`, `WIRE_MESSAGE_ID`, and the
  clock constants. `wireIdClockDelta(clock, reference)` is the signed distance
  between two clocks on the 48-bit ring and `maxWireIdClock(clocks)` the newest
  of several; compare clocks with these, never with `>`, so ids on both sides
  of a wrap keep their order. Exported from the root and from
  `@kortix/sdk/wire-message-id`, which loads this one import-free module.
  `mintWireMessageId` is unchanged.
- Typed unified session-cost reads through
  `billing.sessionCosts.{list,get}` and `session(pid,sid).cost()`. The response
  combines finalized LLM and compute costs, model usage, and ledger entries.
- `getProjectModelPicker()` plus `kortix.projects.modelPicker` and
  `kortix.project(id).modelPicker()` for the compact, connection-aware selector
  catalog; the existing `llmCatalog` remains the complete runtime catalog.
- Typed GitHub repository branch discovery through
  `kortix.github.listRepositoryBranches(accountId, installationId, repoFullName)`,
  including GitHub's default branch and branch protection metadata.
- The root entry `@kortix/sdk` is now canonical: it exports the whole
  framework-free surface (client, session, turns, files, event stream, errors).
- CDN builds: a minified ESM bundle (`dist/kortix.esm.min.js`) and an IIFE
  exposing `window.Kortix` (`dist/kortix.global.js`), wired via
  `publishConfig`'s `browser`/`unpkg`/`jsdelivr` fields. Usable from a
  `<script>` tag with no bundler.
- `KortixMasterProject` — the kortix-master daemon's board project.
- `@kortix/sdk/internal/*` for the zustand stores. Not covered by semver.
- `@kortix/sdk/internal/diagnostics-store` and
  `@kortix/sdk/internal/managed-storage`. `apps/web` now imports the SDK's
  LSP diagnostics store and quota-safe storage instead of keeping its own
  copies. Not covered by semver.

### Changed
- `rollbackApp` creates a NEW release from the
  target's artifact and config and answers `202` with the App plus the queued
  release in `deployment`; it no longer moves traffic to the old release in
  place. It resolves with the new `AppRollback` type (`App & { deployment }`),
  a subtype of the `App` it returned before. `AppDeployment` gains `config`,
  `strategy` and `release_command_status`.
- `getAppAuthEnv(projectId, appId)` (facade `apps.authEnv(appId)`) and `AppAuthEnv`:
  `KORTIX_AUTH_ISSUER`, `KORTIX_AUTH_AUDIENCE` and the project key set inline as a
  `data:` URL, for a backend that verifies App sign-in tokens without a network call.
- `App.estimated_monthly_usd` is deprecated: Kortix shows no prices. The field
  stays on the wire; hosts must not display it. `DockerfileAppSource.port` and `OciImageAppSource.port` are optional:
  omit them for a worker-only release (a `config` with `processes` and no
  service).
- Every turn start goes through the session's durable prompt inbox
  (`POST .../prompts`), as the web composer and the CLI already did.
  `session(pid, sid).send(text)` resolves with the `CreateSessionPromptResult`
  once the prompt is durable, no longer with the runtime's reply message; the
  reply arrives on `stream()` and in the transcript. A `failed` verdict throws
  `ApiError` with code `PROMPT_FAILED`. This is a breaking change to the
  return type. `useSession().send` and `sendParts` post the same inbox prompt
  (the wire id is placed by the server, `remintOnDelivery`); a text part's
  `id` stays the host's local correlation key and no longer goes on the wire.
- `openEventStream` / `session(pid, sid).stream()`: consecutive
  `message.part.delta` events for one part field in the same 16 ms flush arrive
  as one event. `properties.delta` is their text joined in order, `id` is the
  last event's id, and `coalesced` lists the wire events it replaced. Appending
  `delta` gives the same text. A consumer that dedupes deltas by event id reads
  the ids from `coalesced` when it is present. The sync store applies the run in
  one update.
- Session open, `useSession`: a session-open snapshot that has already answered
  serves the saved-history read (no second download of the transcript window),
  and its `models` leg seeds `useModelDefaults`, which then needs no
  `/model-defaults` request and no `/detail` answer first.
- `SessionStartResult.capabilities` (optional): what the session's runtime
  serves, listed by the API with `stage: 'ready'`. `useSession` records it when
  the session becomes ready, so `useRuntimeSupports` is right before the first
  `/kortix/health` probe answers. Absent on an older API: the capabilities stay
  unknown until the probe answers, as before.

### Deprecated
- The `config_releases` member of `FeatureFlagKey`. Config releases graduated
  out of the flag system: every session runs its base branch's config release.
  It is absent from `FEATURE_FLAG_KEYS` and `KortixProject.experimental`, and
  `useFeatureFlag(id, 'config_releases')` reports `enabled: true`.
  `updateFeatureFlag(id, 'config_releases', …)` answers `400`. Removed in the
  next major.
- `createCheckoutSession`, `confirmCheckoutSession` and `scheduleDowngrade`
  (and the facade's `kortix.billing.checkout.{createSession,confirmSession}`
  and `kortix.billing.subscription.scheduleDowngrade`). The API retired their
  routes; each now rejects with `ENDPOINT_RETIRED` and sends no request. Use
  `createPerSeatCheckout` for checkout and the Stripe customer portal
  (`createPortalSession`) for a plan change. Removed in the next major.
- `useSession` option `initialOpenCodeSessionId` (use
  `initialRuntimeSessionId`) and `opencodeSessionId` on the
  `useSessionMessages` source (use `runtimeSessionId`). Both keep working; the
  neutral name wins when both are set.
- The message-id clock arithmetic (`wireIdClock`, `wireIdClockAt`,
  `wireIdClockDelta`, `maxWireIdClock`, `isWireIdAheadOf`,
  `newestWireIdClock`, `mintWireMessageIdAbove`, `MintedWireMessageId`,
  `MintWireMessageIdAboveInput`, `WIRE_ID_TIME_SCALE`, `WIRE_ID_TIME_MASK`,
  `WIRE_ID_CLOCK_TOLERANCE`, `WIRE_ID_BACKDATE_MS`). Message ids are the
  Kortix format v1 and opaque to clients; `mintWireMessageId` and
  `WIRE_MESSAGE_ID` stay. The clock goes with OpenCode support.
- `SessionHandle.runtime` (the raw runtime client): use the session verbs.
- `openEventStream({ client })`: pass `url`.
- The `teams` member of `FeatureFlagKey`. Microsoft Teams graduated out of the
  flag system: every project can connect Teams. It is absent from
  `FEATURE_FLAG_KEYS` and `KortixProject.experimental`, and
  `useFeatureFlag(id, 'teams')` reports `enabled: true`.
  `updateFeatureFlag(id, 'teams', …)` answers `400`. Removed in the next major.
- The `session_transcript_history` member of `FeatureFlagKey`. Saved session
  history graduated out of the flag system: every session saves its transcript
  and shows it while its computer is off. It is absent from
  `FEATURE_FLAG_KEYS` and `KortixProject.experimental`, and
  `useFeatureFlag(id, 'session_transcript_history')` reports `enabled: true`.
  `updateFeatureFlag(id, 'session_transcript_history', …)` answers `400`.
  `useSession` now starts its saved-history read at mount instead of after the
  project detail answers. Removed in the next major.
- The `agent_tunnel` member of `FeatureFlagKey`. Computers need no flag. It is
  absent from `FEATURE_FLAG_KEYS`, and `useFeatureFlag(id, 'agent_tunnel')`
  reports `enabled: true`. Removed in the next major.
- `ConnectorConfig.tunnelIds` and `ConnectorDraftInput.tunnel_ids`. A
  `computer` connector no longer carries a machine list; each machine is an
  account. Servers do not send the first and ignore the second.
- `@kortix/sdk/react` tunnel hooks whose route the API deleted. They fail at
  once with `ENDPOINT_RETIRED` and send no request: `useCreateTunnelConnection`
  (pairing is device auth only), `useTunnelPermissions`,
  `useGrantTunnelPermission`, `useRevokeTunnelPermission`,
  `useTunnelPermissionRequests`, `useApprovePermissionRequest`,
  `useDenyPermissionRequest`, `useTunnelAuditLogs`, and the types
  `TunnelPermission`, `TunnelPermissionRequest`, `TunnelAuditLog`,
  `AuditLogPage`, `TunnelConnectionCreateResponse`. Human approval of a risky
  computer call is a connector policy (`require_approval`).
- `buildTunnelEventStreamUrl`. It builds the URL of the deleted
  `/tunnel/permission-requests/stream` route. Removed in the next major.
- The 20 legacy subpaths (`/projects-client`, `/turns`, `/files`, `/session`,
  `/event-stream`, the stores, …). They still work. Import from the root.
- `KortixProject` **as exported from `@kortix/sdk/opencode-client`** — renamed to
  `KortixMasterProject`. The platform's `KortixProject` (from the root) is
  unchanged and keeps its name.
- The `review_center` member of `FeatureFlagKey`. Review Center graduated out
  of the flag system and is on for every project. The key still typechecks, and
  `useFeatureFlag(id, 'review_center')` reports `enabled: true`. The API no
  longer lists, resolves, or accepts it, so it is absent from
  `FEATURE_FLAG_KEYS` and `KortixProject.experimental`, and
  `updateFeatureFlag(id, 'review_center', …)` answers `400`. Removed in the next
  major.
- Functions and hooks whose API route was deleted. The exports remain until the
  next major. Each one now fails at once with an `ApiError` whose `code` is
  `ENDPOINT_RETIRED`, and sends no request (it used to send one that returned
  `404`):
  - referrals: `getReferralCode`, `refreshReferralCode`, `validateReferralCode`,
    `getReferralStats`, `listReferrals`, `sendReferralEmails`;
  - Google Slides: `getGoogleAuthUrl`, `convertPresentationToGoogleSlides`
    (export PDF or PPTX with `convertRuntimePresentation`);
  - templates and warm pool: `getTemplate`, `installTemplate`,
    `updateTemplateWarmPool`;
  - account-level sandbox: `getInvite`, `acceptInvite`, `declineInvite`,
    `deleteInstance`, `claimComputer`, `getSandboxProvisionStreamUrl` (throws).
    `markInstanceError` and `getSandboxProvisionStatus` never threw; they now
    resolve `undefined` and `null` without a request;
  - `@kortix/sdk/react` admin hooks: every hook in `use-admin-analytics`
    (28), `use-admin-feedback` (8), `use-system-status` (4) and
    `use-admin-billing` (4); the per-sandbox hooks `useAdminSandboxDetail`,
    `useAdminSandboxHealth`, `useAdminSandboxHealthBatch`, `useAdminSandboxExec`,
    `useAdminSandboxAction`, `useAdminSandboxRepair`, `useDeleteAdminSandbox`
    and `fetchAdminSandboxProxyToken`; and `useAdminAccountSandboxes`.
    Retired queries never retry or poll.
- The kortix-master client and its React hooks: every function exported from
  `core/runtime/kortix-master.ts` (`listTasks`, `createTicket`, `listServices`,
  …) and `react/use-kortix-master.ts` (`useKortixTasks`, …). The sandbox daemon
  serves none of their `/kortix/tasks|tickets|projects|services` routes: every
  call answers `404`. Behavior is unchanged. Removed in the next major.
- 22 runtime exports that wrap an OpenCode-only route: the MCP hooks
  (`useOpenCodeMcpStatus`, `useAddMcpServer`, `useConnectMcpServer`,
  `useDisconnectMcpServer`, `useMcpAuthStart`, `useMcpAuthCallback`,
  `useMcpAuthRemove`), `useShareSession`, `useUnshareSession`,
  `useUpdatePart`, `useDeletePart`, `useOpenCodeSkills`, `useOpenCodeToolIds`,
  `useOpenCodeProjects`, `useDeleteOpenCodeSession`,
  `getRuntimeProviderAuthMethods`, `authorizeRuntimeProvider`,
  `completeRuntimeProviderOAuth`, `setRuntimeProviderApiKey`,
  `getRuntimeConfig`, `updateRuntimeConfig` and `refreshRuntimeConfiguration`.
  Behavior is unchanged. Removed in the next major.
- The exports in **Removed in the next major** below that were not deprecated
  yet: the `message-queue` reducers and types, the types of the retired admin
  hooks, `useUpdateRuntimeSession`, `useRuntimeSessionDiff`, `useInitSession`,
  `useSendRuntimeMessage`, `useRuntimeAgent` and `useRuntimeTools`, and the
  four `./internal/*` store subpaths. Behavior is unchanged.

### Removed in the next major

The removal list for the next breaking release. No first-party host
(`apps/*`, `packages/*` other than this one) imports any name or subpath
below: check again with `rg -w <name> apps packages -g '!packages/sdk/**'`
before the cut. Each name carries `@deprecated <replacement>. Removed in the
next major.`, and `src/deprecated-exports.test.ts` fails when a tag is
missing. Every other entry under **Deprecated** above that says "Removed in
the next major" goes in the same release.

Subpaths. For each, delete the `exports` and `publishConfig.exports` keys in
`package.json`, its row in `SUBPATH_TIERS` (`src/index.isomorphic.test.ts`),
its entry in `NOT_ROOT_REACHABLE` (`src/root-canonical.test.ts`) when it has
one, and its file.

| Subpath | Replacement | File |
|---|---|---|
| `./opencode-client`, `./config`, `./auth`, `./api-client`, `./projects-client`, `./feature-flags`, `./fresh-sessions`, `./instance-routes`, `./opencode-errors`, `./platform-client`, `./event-stream`, `./files`, `./session`, `./session/url`, `./turns` | `@kortix/sdk` (the same names) | `src/deprecated/<name>.ts` (`./session/url`: `session-url.ts`) |
| `./idb-sync-cache` | `@kortix/sdk/internal/idb-sync-cache` | `src/deprecated/idb-sync-cache.ts` |
| `./sync-store`, `./server-store`, `./sandbox-connection-store`, `./opencode-pending-store` | none; read session state with `useSession` | `src/deprecated/<name>.ts` |
| `./internal/sync-store`, `./internal/server-store`, `./internal/sandbox-connection-store`, `./internal/opencode-pending-store` | none; read session state with `useSession` | `src/internal/<name>.ts` (the stores in `src/browser/stores/` stay) |
| `./message-queue` | `useSession().send` (the server orders prompts) | `src/core/session/message-queue.ts` and its test |

Names.

| Name | Replacement | File |
|---|---|---|
| `claimNext`, `completeInFlight`, `createSessionQueue`, `editQueued`, `enqueue`, `failInFlight`, `removeQueued`, `reorderQueued`, `retryFailed`, `QueuedMessage`, `QueuedMessageInput`, `SessionQueue` (root re-export block in `src/index.ts`) | `useSession().send` | `src/core/session/message-queue.ts` |
| every export (28 hooks, 34 types) | none: the API removed the route | `src/react/use-admin-analytics.ts` (whole file) |
| every export (8 hooks, `useRefreshFeedbackData`, 10 types) | none: the API removed the route | `src/react/use-admin-feedback.ts` (whole file) |
| every export (4 hooks, 5 types) | none: the API removed the route | `src/react/use-system-status.ts` (whole file) |
| `useUserBillingSummary`, `useAdminUserTransactions`, `useAdjustCredits`, `useProcessRefund` | none: the API removed the route | `src/react/use-admin-billing.ts` (whole file) |
| `useAdminSandboxDetail`, `useAdminSandboxHealth`, `useAdminSandboxHealthBatch`, `useAdminSandboxExec`, `useAdminSandboxAction`, `useAdminSandboxRepair`, `useDeleteAdminSandbox`, `fetchAdminSandboxProxyToken`, `AdminSandboxDetail`, `ProviderMachineDetail`, `AdminInstanceLayerStatus`, `AdminInstanceLayerAction`, `AdminInstanceLayerHealth`, `AdminSandboxHealth`, `AdminSandboxHealthBatchResponse`, `ExecResult`, `ProxyTokenResult` | none: the API removed the route | `src/react/use-admin-sandboxes.ts` (`useAdminSandboxes` stays) |
| `useAdminAccountSandboxes`, `AdminAccountSandbox` | none: the API removed the route | `src/react/use-admin-accounts.ts` |
| `useCreateTunnelConnection`, `useTunnelPermissions`, `useGrantTunnelPermission`, `useRevokeTunnelPermission`, `useTunnelPermissionRequests`, `useApprovePermissionRequest`, `useDenyPermissionRequest`, `useTunnelAuditLogs`, `TunnelPermission`, `TunnelPermissionRequest`, `TunnelAuditLog`, `AuditLogPage`, `TunnelConnectionCreateResponse` | device auth; a connector's `require_approval` policy | `src/react/use-tunnel.ts` |
| `useRetiredQuery`, `useRetiredMutation` (not exported) | none: no caller remains | `src/react/retired-endpoint.ts` (whole file) |
| `useOpenCodeRuntimeReady` | `useRuntimeReady` | `src/react/use-opencode-sessions/keys.ts` |
| `useOpenCodeSessions`, `useOpenCodeSession`, `useCreateOpenCodeSession`, `useOpenCodeSessionTodo`, `useSummarizeOpenCodeSession` | `useRuntimeSessions`, `useRuntimeSession`, `useCreateRuntimeSession`, `useRuntimeSessionTodo`, `useSummarizeRuntimeSession` | `src/react/use-opencode-sessions/sessions.ts` |
| `useUpdateRuntimeSession`, `useUpdateOpenCodeSession` | `updateProjectSession` (`name`) | `src/react/use-opencode-sessions/sessions.ts` |
| `useRuntimeSessionDiff`, `useOpenCodeSessionDiff` | `useRuntimeVcsDiff` | `src/react/use-opencode-sessions/sessions.ts` |
| `useInitSession` | `useExecuteRuntimeCommand` with `command: 'init'` | `src/react/use-opencode-sessions/sessions.ts` |
| `useDeleteOpenCodeSession` | `deleteProjectSession` | `src/react/use-opencode-sessions/sessions.ts` |
| `useOpenCodeMessages` | `useRuntimeMessages` | `src/react/use-opencode-sessions/messages.ts` |
| `useSendRuntimeMessage`, `useSendOpenCodeMessage` | `useSession().send` | `src/react/use-opencode-sessions/messages.ts` |
| `useAbortOpenCodeSession` | `useAbortRuntimeSession` | `src/react/use-opencode-sessions/messages.ts` |
| `useOpenCodeAgents`, `useRuntimeAgent`, `useOpenCodeAgent` | `useRuntimeAgents` (select by `name`) | `src/react/use-opencode-sessions/agents.ts` |
| `useRuntimeTools`, `useOpenCodeTools`, `useOpenCodeToolIds`, `useOpenCodeSkills` | none: OpenCode-only routes | `src/react/use-opencode-sessions/tools.ts` |
| `useOpenCodeProjects` | none: OpenCode-only route | `src/react/use-opencode-sessions/projects.ts` |
| `useOpenCodeCurrentProject`, `useOpenCodePathInfo` | `useRuntimeCurrentProject`, `useRuntimePathInfo` | `src/react/use-opencode-sessions/projects.ts` |
| `useOpenCodeCommands`, `useExecuteOpenCodeCommand` | `useRuntimeCommands`, `useExecuteRuntimeCommand` | `src/react/use-opencode-sessions/commands.ts` |
| `useOpenCodeProviders` | `useRuntimeProviders` | `src/react/use-opencode-sessions/providers.ts` |
| `useShareSession`, `useUnshareSession` | none: OpenCode-only routes | `src/react/use-opencode-sessions/sharing.ts` (whole file) |
| `useUpdatePart`, `useDeletePart` | none: OpenCode-only routes | `src/react/use-opencode-sessions/parts.ts` (whole file) |
| `useOpenCodeVcsDiff` | `useRuntimeVcsDiff` | `src/react/use-opencode-sessions/vcs.ts` |

Also in the same change: for a whole file, delete its `export *` line in
`src/react/index.ts` or `src/react/use-opencode-sessions/index.ts`; delete the
lists above from
`src/deprecated-exports.test.ts`; re-record `src/public-surface.snapshot.json`
and `src/public-type-surface.snapshot.json` and confirm the diff only removes
these names; drop the `@kortix/sdk/internal/server-store` entry from
`apps/web/eslint.config.mjs`; drop the `@kortix/sdk/turns` note from
`apps/web/content/docs/sdk/reference.mdx`. `apps/web/scripts/split-tool-renderers.ts`
writes `@kortix/sdk/internal/sync-store` and `useOpenCodeMessages` into the
files it generates; it reads a `.bak` file that no longer exists, so nothing
runs it. Comments in `apps/web` and `apps/api` still name `useOpenCodeAgents`,
`useOpenCodeCommands`, `useOpenCodeMessages`, `useSummarizeOpenCodeSession`
and `useOpenCodeRuntimeReady`; they compile either way.

The 88 `V2Event*` type aliases are already gone (see **Removed** below).

### Fixed
- A session stream's `question.asked`, `question.replied` and
  `question.rejected` events refetch `useSessionsNeedingInput` for the
  stream's project. Before, a question opened or closed showed in the
  session lists only at the next 30 s poll (KRTX-1739).
- `useProjectSessions` ends its read past empty pages (`isScanning`) on a
  failed fetch. Before, it read the failed page again as soon as the fetch
  ended, for as long as the server failed. It also reads the next page when
  a page answers before React renders the fetch that asked for it; before,
  the read stopped there with `isScanning` true and no fetch running
  (KRTX-1727).
- `createScopedKortix` (`@kortix/sdk/server`) runs every `next`, `return`
  and `throw` of a returned async generator inside its scope. Before, each
  `connector(slug).paginate` page ran outside the scope and used the
  process-global config: another client's token and backend.
- `useSession({ chatEngine: false })` no longer reads a transcript for no
  session. Its inner `useSessionSync('')` went busy with the session, and the
  busy to idle step started `GET /session//message`, which answered 400 and
  retried every 15 s.
- `isSandboxNotReadyError` now classifies `sandbox runtime not ready`, the
  text a pi runtime (and OpenCode's boot steps) answers with. Before, only
  `opencode not ready` read as "waking", so a pi session that was still
  booting showed an error.
- `useRuntimeSessionTodo` asks only a runtime that lists `session.todo`. A pi
  runtime is not asked.
- `narrateStep('edit', …)` counts files, not tool calls. A write then an
  edit of one file reads "Updated hello.py", not "Updated 2 files"; a group
  without file paths still counts its calls.
- `safeGetItem`, `safeSetItem`, `ScopedCache` and `pruneAllRegisteredCaches`
  no longer throw when `window.localStorage` resolves to `null` (some
  embedded WebViews do this instead of throwing) or when a resolved storage
  throws on read during quota reclaim or pruning. Added
  `safeSessionGetItem`, `safeSessionSetItem` and `safeSessionRemoveItem` with
  the same guarantee for `sessionStorage`, plus `safeSessionStorage` and
  `createSafeSessionJSONStorage` for zustand `persist` stores.
- `BillingError` (402) and `RequestTooLargeError` (431) now extend `ApiError`.
  `err instanceof ApiError` matches every failed request, and a 402 keeps the
  backend's machine `code` (for example `app_budget_exceeded`), `details` and
  `response`. `instanceof BillingError` and `.detail` are unchanged.
- `backendApi`, `backendApi.postStream` and `authenticatedFetch` now send
  through one module (`core/http/transport.ts`) and share one policy:
  - `authenticatedFetch` (the session runtime, files, PTY) now carries the
    act-as (`X-Kortix-Impersonate`) and admin read-bypass headers, as
    `backendApi` always did;
  - `backendApi` requests now replay a `401` once with a fresh token from
    `getToken()`, as `authenticatedFetch` did;
  - `backendApi.postStream` now honors `configureKortix({ fetch })`, and
    without a token it resolves a `401` without sending an unauthenticated
    request.
- `getPlatformUrl()` no longer reads a bare `process.env`, which threw a
  `ReferenceError` in a browser `<script>` bundle and on React Native.
- The HTTP layer (`backendApi`/`makeRequest`) now transparently retries transient
  `502`/`503`/`504` responses on idempotent reads (`GET`/`HEAD`) up to two times
  with 250ms → 500ms backoff. Mutations and HTTP `500` responses are never
  retried.

### Changed
- `useRuntimeCommands` loads only when the runtime serves `session.commands`,
  and `useRuntimeConfig` only when it serves `session.config`. On pi both stay
  empty instead of asking for documents pi does not have.

### Removed

- The `@opencode-ai/sdk` dependency. The runtime REST client is this
  package's own (`RuntimeClient`, same `{ data, error, request, response }`
  results and the same requests, pinned by a recorded-request test). It
  implements the 55 routes the SDK and its hosts call; `RuntimeClient` no
  longer lists the others (`session.fork`, `pty.*`, `lsp.*`, ...), which is a
  breaking type change for a consumer that called them through
  `session.runtime`.
- The OpenCode type re-export. `@kortix/sdk` and `@kortix/sdk/opencode-client`
  no longer re-export every type of `@opencode-ai/sdk` (1,369 names, among
  them the 88 `V2Event*` aliases and every `*Data`/`*Responses` request
  type). The transcript names are Kortix types now (see Added); the runtime
  types this package still reads (`Session`, `Agent`, `Command`, `Config`,
  `Model`, `Provider`, `ProviderListResponse`, `McpStatus`, `Project`,
  `Path`, `Pty`, `VcsFileDiff`, `Worktree*`, `FileContent`, the
  `ProviderAuth*` types and the `Event` union of the 37 runtime events it
  handles) are declared in this package, frozen at `@opencode-ai/sdk`
  1.18.23. A consumer that imported any other OpenCode type from this
  package must import it from `@opencode-ai/sdk`. This is an intentional
  breaking type-contract change and requires a breaking SDK release.

- The retired local sandbox value was removed from `AppHostingProvider`. This
  is an intentional breaking type-contract change and requires a breaking SDK
  release. The API no longer accepts or emits that value.

### Internal
- Deleted dead internal code: `src/react/model-lookup.ts` (a re-export no
  entry point reached) and nine unread non-exported functions, constants,
  variables and imports. No public name changed.
- `src/` is now tiered: `core/` (isomorphic), `browser/`, `node/`, `react/`.
  A file's directory declares what it may import, enforced by the tripwire.
- A bare-global tripwire (`process`/`window`/`document`/`localStorage`/
  `sessionStorage`) now runs over `core/`, with `safeEnv()` extracted to
  `core/http/env.ts` as the one sanctioned way to read an env var from
  isomorphic code.
- `turns/index.ts` (1434 loc) split into `parts`/`grouping`/`shell`/`state`.
- CI now packs, installs, and imports the tarball, and asserts the two export
  maps agree.
- The install smoke test (`pnpm run smoke:install`) packs `@kortix/llm-catalog`
  alongside the SDK at a synthetic version and installs both tarballs
  hermetically, since the `workspace:*` dependency between them gets pinned to
  the release version at publish time.

## 0.2.0

Headline: **"Kortix as a Backend"** — everything a third-party server needs to
safely wrap Kortix on behalf of multiple concurrent end users, plus a
framework-free headless chat kit and a batch of previously web-local REST
domains promoted into the facade.

### Added

- **`@kortix/sdk/server`** — `runWithKortix(config, fn)` / `createScopedKortix(config)`.
  Per-request platform-config isolation via Node's `AsyncLocalStorage`, so a
  multi-tenant wrapper backend can safely handle concurrent requests carrying
  different end-user tokens without racing on the process-global
  `configureKortix()` singleton. Never reachable from the root `@kortix/sdk` or
  `@kortix/sdk/react` entry points, so `node:async_hooks` never enters a
  browser bundle.
- **Headless chat kit** — `classifyPart`/`classifyTurn`/`toolInfo`/`ToolView`
  (`@kortix/sdk/turns`, also re-exported from the root barrel) normalize every
  opencode part kind (text, reasoning, tool, file, subtask, patch, snapshot,
  agent, retry, compaction, step) into a typed, compile-time-exhaustive
  `ClassifiedPart` — plus `KortixChatEvent`/`narrowChatEvent` (a curated
  14-member event union narrowed from the raw ~50-variant SSE wire union) and
  `useChatTurns`/`renderParts`/`PartRenderers` (`@kortix/sdk/react`), a
  React binding that requires a renderer for every part kind at compile time.
- **`session(pid, sid).stream()`** — a framework-free facade over the
  `openEventStream` primitive, bound to that handle's own resolved runtime.
  Safe to call from a server-side wrapper, a worker, or a CLI — no React
  required. `@kortix/sdk/react`'s `useOpenCodeEventStream` is now a thin
  wrapper over the exact same primitive.
- **`session(pid, sid).files`** — the same 12-op workspace-files surface as
  the top-level `files` export, but bound to THIS session's own runtime
  instead of the process-global "active" sandbox — fixes cross-session bleed
  for a host juggling multiple concurrently open sessions.
- **`session(pid, sid).ensureReady()` concurrency dedup** — concurrent calls
  for the same `(projectId, sessionId)` now ride a single in-flight `/start`
  long-poll instead of each issuing their own.
- **New facade namespaces**, all with client fns already in
  `@kortix/sdk/projects-client`:
  - `accounts.tokens` / `project(id).tokens` — CLI PAT minting (account- and
    project-scoped `kortix_pat_...` tokens).
  - `billing.*` — `accountState`, `accountStateMinimal`, `transactions`,
    `transactionsSummary`, `creditBreakdown`, `usageHistory`,
    `tierConfigurations` (read-only entitlement/usage surface), plus a curated
    mutation surface: `billing.checkout.{createSession, confirmSession}`,
    `billing.subscription.{createPortalSession, cancel, reactivate,
    scheduleDowngrade, cancelScheduledChange, prorationPreview}`,
    `billing.credits.{purchase, autoTopupSettings, configureAutoTopup}`.
  - `project(id).marketplace` / `.registry` — install/list/updates/update/
    updateAll/remove for a catalog item on a project's default branch.
  - `marketplace.*` — public marketplace catalog browse + sources
    (`items`, `item`, `itemFile`, `marketplaces`, `featured`,
    `sources.{list,add,remove}`), top-level and distinct from the
    install-scoped `project(id).marketplace`.
  - `session(pid, sid).transcript()` — compact server-side transcript read
    (text + tool calls, no tool inputs/outputs), callable with project-scoped
    session tokens.
  - `project(id).changeRequests.requestChanges()` — Review Center feedback on
    a change request.
  - `accounts.audit.*` — Enterprise audit log (`log`, `export`, `webhooks.{list,create,update,remove}`).
  - `project(id).setupLinks.{requestSecret, requestConnector}` —
    agent-minted, short-lived links for a human to enter a secret value or
    1-click connect a Pipedream app, without the agent seeing the credential.
  - `project(id).validateManifest(raw)` / `project(id).gitToken()` —
    server-side `kortix.toml` validation and scoped git push token minting
    for a managed project.
  - `project(id).channels.slack.{getFile, uploadFile}` /
    `project(id).channels.meet.speak(botId, text, voice?)` — Slack file
    download/upload proxy and the Meet bot "speak" action.
  - `project(id).gateway.playground(prompt, models)` — run one prompt
    against up to 6 models side by side.
  - `validateToken()` — pasted-API-key validation helper (`GET /accounts/me`,
    never throws).
- **Domain hooks** (`@kortix/sdk/react`) — `useProjectSecrets`,
  `useProjectTriggers`, `useChangeRequests`: thin React Query bindings with
  their own query key + invalidation-wired mutations, over CRUD surfaces that
  previously had a client fn but no SDK-owned hook.
- Root barrel (`@kortix/sdk`) now type-only re-exports the full set of domain
  result types (`ProjectDetail`, `AccountState`, `GatewayOverview`,
  `MarketplaceInstalledItem`, `AuditEvent`, `AccountToken`, …) from
  `platform/projects-client`, so a consumer can name a facade call's return
  type without a second import.
- **`examples/`** — six runnable, self-contained scripts covering the facade
  (list projects), send+stream, the server wrapper pattern, transcript
  rendering, cost pass-through/re-billing, and files+secrets. Typechecked via
  `examples/tsconfig.json` as part of `pnpm typecheck`.

### Changed

- **One typed error hierarchy across every HTTP layer.** `ApiError`/`AuthError`
  are now real classes (`instanceof`-able, enumerable `message`, `name`/shape
  preserved for legacy string-sniffers) instead of ad-hoc
  `Object.create(Error.prototype)` objects — and every layer (`backendApi` /
  `platformFetch`/`authenticatedFetch`, the files client, the opencode client,
  `ensureReady()`) now throws/returns the SAME classes instead of duck-typed
  shapes. `BillingError`/`RequestTooLargeError` + their helpers
  (`parseBillingError`, `isBillingError`, `formatBillingErrorForUI`) are
  exported from the root barrel and `@kortix/sdk/api-client`, not just
  `@kortix/sdk/react` — a server-side wrapper can now `instanceof BillingError`
  a 402 and pass the cost/upgrade payload straight through to its own client
  without importing a React-flavored subpath.
- **30-second default request timeout** on `authenticatedFetch` and the
  `backendApi`/`platformFetch` layer, so a hung sandbox/daemon request can't
  wedge a "Kortix as a Backend" server handler forever. The long-lived SSE
  event-stream endpoint (`/global/event`) is explicitly exempted.
- `getAuthTokenWithRetry`'s `attempts`/`baseDelayMs` options now actually
  drive a retry loop (previously accepted but not applied).
- `previewUrl()`/`proxyUrl()` tolerate a relative `backendUrl` (a same-origin
  BFF proxy pattern) by resolving against the page origin in the browser, and
  now read the LIVE platform config instead of the config captured at
  `createKortix()` time — so a host that calls `configureKortix()` again after
  creation (e.g. switching into wrapper mode) is followed correctly.

### Fixed

- `session(pid, sid).stream()` — the README documented this method before it
  existed; the API-MAP gap is now closed with a real, tested implementation.
- `API-MAP.md`'s transcript row previously read "✅" with no client function
  actually behind it — `getSessionTranscript`/`session(pid,sid).transcript()`
  are now genuinely wired, and the doc reflects that.

## 0.1.0

Initial internal release — the single opinionated `createKortix()` facade
over the Kortix REST API + OpenCode v2 runtime, `@kortix/sdk/react` hooks,
the workspace files client, and the framework-free session/transcript/event-
stream primitives.
