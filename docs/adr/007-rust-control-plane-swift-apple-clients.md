# ADR-007: Rust Control Plane and Native Swift Apple Clients

- **Status:** Proposed
- **Date:** 2026-09-02
- **Deciders:** Platform Engineering and Client Engineering
- **Program type:** Incremental runtime migration

## Context

Kortix is a TypeScript monorepo. The current API is a private Bun/Hono monolith.
Its package description names router, billing, platform, cron, and sandbox proxy
responsibilities. The repository also contains TypeScript workers, an LLM
gateway, a sandbox agent server, a published TypeScript SDK, a Next.js web app,
an Expo/React Native mobile app, and an Electron desktop wrapper.

This is a live contract, not a greenfield system. At this ADR's baseline:

- `tests/src/flows/*.flow.ts` registers **454 end-to-end flows**;
- `tests/spec/routes.generated.json` records **635 HTTP routes**;
- `@kortix/sdk` is the public TypeScript client and the source of truth for
  backend access by JavaScript hosts;
- PostgreSQL schema and migrations live in `packages/db` and use Drizzle plus
  `node-pg-migrate` tooling;
- Supabase supplies authentication and storage contracts;
- the web, mobile, desktop, CLI, API, gateway, workers, and sandbox processes
  ship on different platform and release paths.

The counts describe the current baseline. They will change as product behavior
changes. Each migration tranche must regenerate the route manifest and record
the current flow count. A smaller count is not evidence of successful
migration unless an approved product change removed the behavior.

A single rewrite would combine language, runtime, protocol, data, deployment,
and client risks. It would also remove the working implementation before its
replacement has production evidence. We will instead replace bounded behavior
behind existing contracts.

## Decision

Use a strangler migration with two target implementation families:

1. **Rust owns portable control-plane and systems code.** This includes server
   request handling, background work, gateway logic, CLI logic, sandbox control
   clients, protocol codecs, and other non-UI processes selected by the phases
   below.
2. **Swift owns native Apple product surfaces.** A shared Swift package will
   implement the Kortix HTTP, SSE, WebSocket, authentication, and model layer.
   Native iOS and macOS applications will consume that package.

The migration preserves the existing external contracts. It does not require a
coordinated cutover of the server and clients. Rust and Bun implementations will
coexist during server migration. Swift and existing JavaScript clients will
coexist during Apple client migration.

Do not use a Rust-to-Swift FFI boundary in the first program. Both client
families consume the same network contract. This keeps memory ownership,
concurrency, packaging, crash handling, and App Store review independent.
Reconsider UniFFI or a C ABI only after duplicated pure logic has measured cost.

## Scope

### Rust target

The target Rust workspace has these logical boundaries:

```text
clients
  web / Android / Windows / Linux -> @kortix/sdk -> public API
  iOS / macOS                     -> KortixKit   -> public API

edge
  ingress -> compatibility router -> Rust route owner
                                  -> Bun legacy route owner

Rust workspace
  kortix-contracts   request, response, event, and error types
  kortix-auth        JWT, API-key, PAT, account, and policy checks
  kortix-db          PostgreSQL queries and transaction boundaries
  kortix-api         HTTP handlers and middleware composition
  kortix-stream      SSE and WebSocket framing and lifecycle
  kortix-jobs        cron and background job execution
  kortix-gateway     LLM gateway policy and forwarding
  kortix-sandbox     provider-neutral sandbox control client
  kortix-cli         portable command-line application
  kortix-telemetry   logs, metrics, traces, and request correlation
```

These are architectural boundaries, not a requirement for nine independently
deployed services. Start with a Cargo workspace and a small number of binaries.
Split a deployable only when it needs independent scaling, isolation, or release
control. Do not replace one monolith with a distributed monolith.

Rust contract types do not replace `@kortix/sdk`. Generate or validate both from
one reviewed wire schema where practical. The published JavaScript names and
behavior remain public API contracts. The web and other JavaScript hosts remain
thin SDK consumers.

### Swift target

Create a Swift package, provisionally `KortixKit`, with these modules:

- **KortixCore:** wire models, stable identifiers, errors, pagination, and
  capability negotiation;
- **KortixTransport:** HTTP, SSE, WebSocket, retry, cancellation, and request
  correlation built on Apple platform networking;
- **KortixAuth:** token storage and refresh interfaces, with Keychain-backed
  application adapters;
- **KortixSession:** one session lifecycle that matches the server session and
  streaming contracts;
- **KortixUI support:** optional, small platform-neutral view models. Product UI
  remains in the native applications.

Use Swift structured concurrency. Treat cancellation, background suspension,
reconnection, and duplicate event delivery as normal states. Keep credentials
out of models, logs, and persistent caches. Do not put business authorization in
the client.

Build native iOS and macOS shells only after `KortixKit` passes contract tests
against the unchanged production-compatible API. Client migration must not
force a server migration.

### Surfaces preserved in their current language

- **Web:** Keep Next.js/React/TypeScript. Browsers require JavaScript, and the
  current `@kortix/sdk` is the correct host boundary.
- **Published JavaScript SDK:** Keep `@kortix/sdk`. Preserve its exports and wire
  behavior. Rust may generate fixtures or schemas, but it does not become an
  app-local transport through WebAssembly.
- **Android:** Keep the Expo/React Native Android application for this program.
  Do not start an unrelated Kotlin rewrite. It continues to use
  `@kortix/sdk`. A native Android decision requires a separate ADR.
- **Windows and Linux desktop:** Keep Electron and its web-app wrapper. Swift
  cannot serve these platforms. Preserve `build:win` and `build:linux` release
  capability. A Tauri or other Rust desktop shell is a separate product
  decision, not an implied part of this migration.
- **Product configuration and templates:** Keep formats such as JSON, YAML, and
  TOML stable. Language migration does not authorize format churn.

## Non-goals

This program does not:

- rewrite the Next.js web application in Rust or Swift;
- replace PostgreSQL, Supabase Auth, Supabase Storage, or the public API shape;
- rename published SDK exports or change session/OpenCode streaming semantics;
- rewrite Android in Kotlin;
- remove Windows or Linux desktop support;
- replace Electron on Windows or Linux;
- split every Rust crate into a network service;
- introduce Rust/Swift FFI before a measured need exists;
- move production sandbox workloads to Apple Container;
- perform a big-bang data migration;
- make an exact source-line reduction a success metric;
- accept a behavior change only because the new implementation is cleaner.

## Contract authority

Migration work must distinguish three sources of truth:

1. **Product behavior:** `tests/spec/end-to-end.md` and its registered flows.
2. **HTTP inventory:** `tests/spec/routes.generated.json`, regenerated from the
   actual router after route changes.
3. **Client contract:** `@kortix/sdk`, its documentation, and its public exports.

The old implementation is evidence, not an ideal specification. When tests,
documentation, and production behavior disagree, resolve the contract before
porting the code. Add a characterization test first. Do not reproduce an
unknown bug silently and do not fix one only in the replacement.

## Compatibility gates

Every Rust-owned route or Swift-owned user flow must pass the applicable gates.
A tranche cannot receive production traffic until all required gates pass.

### HTTP and protocol parity

Compare the legacy and replacement implementations for:

- method, path, query parsing, path decoding, and trailing-slash behavior;
- authentication challenge and authorization result;
- status code, response body, content type, and contract-relevant headers;
- JSON nullability, omitted fields, enum spelling, integer precision, timestamp
  format, ordering guarantees, and pagination cursors;
- error code, safe error message, retry classification, and correlation ID;
- idempotency keys, duplicate requests, conditional requests, and timeouts;
- upload/download streaming, byte ranges, content disposition, and size limits;
- SSE event name, ID, data framing, ordering, resume, heartbeat, and disconnect;
- WebSocket upgrade, subprotocol, close code, ping/pong, idle keepalive,
  backpressure, and reconnect behavior;
- webhook signature verification, raw-body handling, and replay protection.

Golden fixtures must cross language boundaries in both directions. Rust must
read TypeScript-produced fixtures. TypeScript and Swift must read Rust-produced
fixtures. Never use only Rust-to-Rust serialization tests as compatibility
proof.

### Repository gates

For each tranche:

1. Run the focused new tests and prove the replacement fails before the
   implementation where TDD applies.
2. Run every affected registered flow through the real process and network
   surface.
3. Run the complete repository gate with `pnpm test`.
4. Run `pnpm test -- --full` before preview or release qualification.
5. Run the preview origin with `pnpm test -- --target-full`.
6. Confirm that every route in the regenerated route inventory has one explicit
   owner: legacy, Rust, intentionally shared infrastructure, or approved
   removal.
7. Confirm the current flow and route counts against the tranche baseline. The
   initial guardrail is **454 flows and 635 routes**.
8. Run client black-box tests separately for web, iOS, macOS, Android, Windows,
   and Linux when the tranche can affect that client.

No flow exclusion, `todo`, mock-only pass, or skipped target counts as parity.
The release gate must verify the deployed source SHA, not only `/health`.

### Operational gates

A Rust deployment must emit the existing request correlation data and required
metrics before it receives traffic. Dashboards must distinguish legacy and Rust
owners. Define service-level thresholds before each canary. At minimum compare:

- error and timeout rate;
- p50, p95, and p99 latency;
- CPU and resident memory per unit of traffic;
- connection, task, and database-pool saturation;
- SSE/WebSocket connection duration and abnormal close rate;
- queue lag and duplicate job execution;
- billing, ledger, and audit reconciliation totals.

A performance regression is not accepted merely because behavior tests pass.
Each tranche records a budget from the legacy production baseline and an
explicit allowed delta.

## Phased strangler plan

Each phase produces a reversible production unit. Phases can overlap only when
they do not share a mutable contract or data owner.

### Phase 0: Freeze the baseline and install the seam

- Record the 454-flow and 635-route inventories at a named Git SHA.
- Map each route, job, stream, database table, external integration, and client
  to an owner and test coverage.
- Capture production-compatible golden requests, responses, and events with
  secrets and personal data removed.
- Add a compatibility router that selects exactly one implementation per
  request. The routing decision must be observable and controlled by an
  independent kill switch.
- Establish a Rust workspace, toolchain lock, dependency policy, SBOM, security
  scan, formatting, lint, test, and cross-compilation gates.
- Establish cross-language contract fixtures for TypeScript, Rust, and Swift.

**Exit:** Zero product routes need Rust. The seam can route a synthetic probe to
Rust and return all product traffic to Bun without a redeploy.

### Phase 1: Port pure and low-risk portable components

- Port protocol codecs, validation helpers, identifiers, retry classification,
  and telemetry primitives.
- Build the Rust CLI behind the existing executable name and output contract.
- Compare real CLI process exit codes, stdout, stderr, file changes, Git changes,
  and API requests.
- Do not port authorization decisions by copying scattered conditions. First
  define one policy contract and its decision table.

**Exit:** Cross-language fixtures pass. CLI flows pass for both binaries. The
legacy CLI artifact remains available for immediate rollback.

### Phase 2: Port stateless edge and read-only server slices

- Select cohesive, low-risk route groups with no writes or streaming.
- Shadow only safe reads. Send the canonical response from Bun while comparing a
  Rust response asynchronously. Redact sensitive values before diff storage.
- Never shadow requests that consume one-time tokens, rate limits, billable
  resources, or external side effects.
- Promote one route group at a time from 0% to canary, then to full traffic.

**Exit:** The route group has zero unexplained semantic diffs for the agreed
sample and duration. Full gates and operational budgets pass.

### Phase 3: Port transactional write slices and jobs

- Port one bounded business capability at a time, including its validation,
  authorization, transaction, audit, billing, and read-back path.
- A request has one writer. Do not dual-write to Bun and Rust.
- Use idempotency and database constraints to make retries safe.
- Give every scheduled job one elected owner. A mixed deployment must not run
  the same cron or queue consumer twice.
- Reconcile row counts, ledger sums, audit events, and external side effects
  before increasing traffic.

**Exit:** The capability passes write/read-back/negative/cleanup flows under
  mixed-version deployment. Reconciliation has no unexplained difference.

### Phase 4: Port session, proxy, and streaming paths

This is the highest-risk server phase. It includes session start, sandbox
selection, OpenCode compatibility, SSE, WebSocket, file transfer, preview
proxying, and long-lived connection recovery.

- Preserve `session_id`, sandbox identity, native conversation identity, event
  ordering, and `@kortix/sdk` session semantics.
- Test idle connections beyond every known intermediary timeout.
- Test client and upstream disconnects, deploy draining, replay, reconnect,
  backpressure, partial frames, and process restart.
- Route an entire connection to one owner. Never switch an established stream
  between Bun and Rust.
- Drain old tasks before termination. Publish a maximum drain interval and a
  close/reconnect contract.

**Exit:** Real sessions pass on local, preview, and dev through web and CLI.
Long-duration SSE/WebSocket tests meet the operational budget. The Bun stream
owner remains deployable for the rollback window.

### Phase 5: Complete remaining server capabilities

- Port remaining API groups, workers, gateway behavior, provider clients, and
  administrative surfaces by bounded capability.
- Remove a Bun owner only after the route inventory shows no route, job, or
  stream assigned to it.
- Keep TypeScript packages required by web and SDK consumers.

**Exit:** Rust owns every server, CLI, and systems surface selected in Scope.
No production request or background job requires the legacy Bun implementation.

### Phase 6: Ship `KortixKit` and native Apple clients

This phase can begin after Phase 0 contract fixtures stabilize. It need not wait
for Rust server completion.

- Implement `KortixKit` against the existing API first.
- Run the same network fixtures against Bun and Rust deployments.
- Deliver native iOS behind controlled distribution. Preserve deep links, push
  notifications, authentication, purchases, background behavior, files, and
  session streaming before general release.
- Deliver a native macOS client without changing Windows or Linux artifacts.
- Use server capability negotiation or additive API versioning. Do not branch on
  guessed server versions.
- Support at least the current and previous released server/client combination
  during rollout.

**Exit:** Native iOS and macOS meet the user-flow, crash-free, performance,
accessibility, signing, update, and rollback gates. The Expo iOS and Electron
macOS artifacts remain available through the declared rollback window.

### Phase 7: Retire legacy owners

- Hold a full release window after 100% traffic before deleting fallback code.
- Prove logs contain no calls to legacy-only routes or client capabilities.
- Remove routing flags, duplicate deployables, compatibility adapters, and dead
  dependencies in separate reviewable changes.
- Archive final golden fixtures and the route/flow ownership ledger.
- Update operator, self-host, SDK, client, incident, and release documentation.

**Exit:** The definition of done below is satisfied. Removal remains separate
from the traffic cutover so rollback is available during observation.

## Data and migration constraints

PostgreSQL remains the system of record. This program changes application
owners, not database identity.

1. **One migration history.** Keep `packages/db/migrations` authoritative until
   a separately approved tool migration proves identical ordering, checksums,
   advisory locking, status, up, and recovery behavior. Never maintain parallel
   TypeScript and Rust migration histories.
2. **Applied files are immutable.** Do not edit, reorder, or squash an applied
   migration. Repair metadata only through the established migration process.
3. **Serialize generation.** Two migrations generated from the same Drizzle
   snapshot parent create a fork. Rebase and regenerate the later migration
   before merge.
4. **Expand, migrate, contract.** Add nullable columns or parallel structures
   first. Deploy code that handles both shapes. Backfill in bounded resumable
   batches. Enforce constraints later. Remove the old shape only after all
   supported versions stop using it.
5. **Mixed-version safety.** Schema changes must support the deployed legacy and
   Rust versions for the complete rollout and rollback window. A Rust deploy
   cannot require a destructive migration in the same step.
6. **Single writer.** Route ownership selects one write implementation. If a
   temporary dual-write is unavoidable, require idempotency, durable outbox
   semantics, ordering rules, and an automated reconciler before use.
7. **Transaction parity.** Preserve isolation, locking, constraint, audit,
   billing settlement, and retry boundaries. Equivalent rows are insufficient
   if failure atomicity changes.
8. **Type parity.** Test UUIDs, time zones, microsecond precision, JSON/JSONB,
   decimals, 64-bit integers, byte arrays, arrays, enums, and nullable values
   with production-shaped fixtures.
9. **Backfill controls.** Record rate, batch size, resume cursor, lock impact,
   replica lag, pause control, verification query, and rollback action. Never
   hide a backfill inside service startup.
10. **Environment isolation.** Staging uses `STAGING_DATABASE_URL`. It must not
    fall back to dev, test, or production data.
11. **Backup proof.** Take and identify a recovery point before destructive
    contract phases. Restore it into an isolated environment and verify the
    critical read paths. A configured backup without a restore test is not a
    rollback plan.
12. **Secrets and personal data.** Do not copy production secrets or raw personal
    data into fixtures, diff logs, preview databases, or client test bundles.

A database migration may be forward-only when reversing it would lose valid new
data. In that case, application rollback means deploying compatible old code
against the expanded schema. The plan must state this before migration approval.

## Deployment strategy

### Server

Deploy Rust as a separate artifact beside the legacy API first. The edge or
compatibility router uses a version-controlled allowlist of Rust-owned route
groups. It must support these controls independently:

- global Rust disable;
- route-group disable;
- account or tenant canary;
- percentage canary for stateless routes;
- shadow-read sampling;
- job-owner election;
- long-lived connection drain.

Use a new flag for each new default-on path. Do not reuse an experiment flag as
a kill switch. Search every deploy workflow and deployment script for injected
values before defining flag semantics.

Traffic progression is `0% -> internal accounts -> bounded canary -> 25% -> 50%
-> 100% -> observation window -> legacy removal`. Each step requires explicit
metric and reconciliation approval. Stateful streams use account or session
cohorts, not per-request percentages.

Preview orchestration executes from the default branch. Any new file that the
preview workflow itself reads must land on the default branch before a feature
branch depends on it. A preview's successful image build does not prove its
orchestration contains branch-only changes.

Promote through local, preview, dev, staging, then production. Verify the
artifact SHA at every deployed surface. Staging migrations run only against the
staging data plane. Production release uses the existing staging-to-production
process. This ADR does not authorize merging or promoting a tranche.

### Apple clients

Use phased App Store/TestFlight and signed macOS distribution cohorts. Keep the
last compatible Expo iOS and Electron macOS artifacts available. Server changes
must remain backward compatible for the declared mobile adoption window because
installed clients cannot be recalled.

Native client telemetry must identify client family and version without
recording credentials or user content. Crash-free sessions alone do not prove
network or product parity. Monitor authentication, session creation, reconnect,
purchase, notification, and file-operation success separately.

## Apple Container

Apple Container has a limited, optional role:

- It may provide a developer-only local Linux container backend on supported
  macOS hosts.
- It may support native macOS integration tests that need an isolated local
  Linux process.
- It must sit behind the same provider-neutral sandbox contract as other local
  backends.

It is **not**:

- a production cloud sandbox provider;
- a replacement for the ordinary-Linux-VPS `sandboxd` direction in ADR-006;
- available to Android, Windows, Linux, Intel Mac, or older macOS hosts by
  assumption;
- a reason to change OCI images or the remote sandbox protocol;
- a required dependency for server, CLI, Swift package, or client development.

The default development and self-host paths must continue to work without Apple
Container. Adoption requires a separate measured prototype covering host
requirements, networking, persistence, resource limits, image compatibility,
and cleanup.

## Rollback

Rollback is designed per tranche before traffic starts.

### Immediate server rollback

1. Stop traffic progression.
2. Set the route-group kill switch to legacy ownership.
3. Stop new Rust job leases and confirm one legacy job owner.
4. Drain Rust streams until the published deadline. Force clients to reconnect
   to the legacy owner only after the deadline.
5. Verify health, error rate, queues, database pool, audit events, billing
   settlement, and data reconciliation.
6. Preserve Rust logs, traces, request IDs, build SHA, and diff samples for the
   incident record.

Do not roll back by editing routing code and waiting for a new build. The tested
kill switch is the first action. Do not send a failed write automatically to the
other implementation unless the operation is proven idempotent and the first
owner's commit state is known.

### Data rollback

Prefer application rollback on the expanded schema. Pause backfills rather than
running an untested reverse transform. If data corruption occurred, isolate the
affected cohort, stop writers, restore or repair from the verified recovery
point, and reconcile external side effects. Never restore the whole database to
fix one tenant without a documented blast-radius decision.

### Apple client rollback

- Stop the rollout and distribution of the native release.
- Keep the server compatible with installed native clients.
- Direct new installs to the last approved artifact where store controls allow.
- Use remote capability controls only for optional features. Authentication,
  account access, data export, and safe session termination cannot depend on a
  remote UI flag.
- Ship an expedited corrective release when an installed binary is defective.
  Server rollback cannot erase an already installed client.

A rollback completes only after the original contract passes again and all
writes during the event reconcile.

## Definition of done

The program is complete only when all statements are true:

- Every in-scope route, stream, job, CLI command, and provider interaction has a
  named Rust owner and no required Bun owner.
- The current full flow catalog passes against the Rust deployment with no
  migration-specific exclusion. The baseline began at 454 flows.
- Every current route in the generated inventory has an explicit owner or an
  approved removal. The baseline began at 635 routes.
- `@kortix/sdk` remains compatible and its supported web, Android, Windows, and
  Linux consumers pass black-box tests.
- Native iOS and macOS pass the approved product-flow matrix against both the
  minimum supported server and current server.
- Mixed-version, rollback, long-lived stream, job-election, and database restore
  exercises have run with recorded evidence.
- Production canary and full-traffic observation meet the agreed SLO and cost
  budgets for one complete release window.
- Database reconciliation has zero unexplained differences. Billing and audit
  invariants hold.
- Security review covers Rust unsafe code, dependencies, auth, request parsing,
  SSRF, sandbox boundaries, secret handling, Swift Keychain use, and client
  transport security.
- Self-host documentation preserves generic Linux operation. Apple Container is
  optional and clearly bounded.
- Android, Windows, and Linux release artifacts still build, install, and reach
  the supported server contract.
- On-call runbooks, dashboards, alerts, SBOMs, release steps, and ownership maps
  describe the new system.
- Legacy deployables remain available through the rollback window and are then
  removed with their flags, dead code, credentials, and operational resources.

“Rust compiles,” “Swift builds,” reduced TypeScript line count, and passing unit
tests are not definitions of done.

## Consequences

### Positive

- The highest-risk behavior moves in small, observable, reversible units.
- Rust provides one portable systems implementation for Linux servers and the
  CLI without coupling it to Apple UI code.
- Swift clients can use native Apple lifecycle, security, accessibility, and
  distribution features.
- Web, Android, Windows, and Linux product continuity does not depend on an
  Apple-only technology choice.
- Contract fixtures and ownership inventories remain useful after migration.

### Negative

- Two server implementations and two Apple client implementations coexist for
  multiple releases.
- Cross-language contract testing, release artifacts, telemetry, and on-call
  diagnosis add temporary operational cost.
- A strangler retains some legacy structure until the last dependent route or
  client moves.
- Server compatibility windows slow destructive schema and protocol changes.
- Native Apple applications create a permanent product and release surface.

## Alternatives considered

### Big-bang Rust server rewrite

Rejected. It withholds production evidence until the largest possible cutover
and couples all 635 baseline routes to one rollback event.

### Rust everywhere, including web through WebAssembly

Rejected. WebAssembly does not remove the JavaScript host, React integration,
browser networking, or the public SDK contract. It adds another packaging and
debugging boundary.

### Swift server and Apple clients

Rejected. Swift is suitable for Apple clients, but a Swift server does not give
this program a portable shared systems target for Linux services and CLI
artifacts.

### Rust server with unchanged Apple clients

Viable as a smaller server-only program, but it does not meet the native Apple
client objective. The phases keep this as a safe stopping point if client value
or cost assumptions fail.

### Rewrite every client natively at once

Rejected. It creates unrelated Kotlin and desktop migration programs and risks
Android, Windows, and Linux continuity.

### Apple Container as the standard sandbox runtime

Rejected. It is host-specific and cannot satisfy Linux production, self-host,
Android, Windows, or Linux desktop requirements. Its approved role is optional
macOS development and testing only.

## Repository evidence for this decision

The baseline facts come from these files at the ADR's authoring branch:

- `apps/api/package.json`: Bun/Hono API monolith and current dependencies;
- `packages/sdk/package.json`: published `@kortix/sdk` exports and client role;
- `packages/db/package.json` and `packages/db/migrations`: current migration
  tooling and history;
- `apps/mobile/package.json`: Expo/React Native iOS and Android surface;
- `apps/desktop-electron/package.json`: macOS, Windows, and Linux builds;
- `tests/src/flows/*.flow.ts`: 454 registered `flow(...)` declarations;
- `tests/spec/routes.generated.json`: generated route count of 635;
- `.github/workflows/deploy-dev.yml`, `deploy-staging.yml`, and
  `deploy-prod.yml`: current environment promotion surfaces;
- `docs/adr/006-local-sandbox-runtime.md`: ordinary Linux VPS sandbox decision;
- `.claude/skills/learnings/SKILL.md`: incident-derived migration, preview,
  deployment, WebSocket, and release constraints.
