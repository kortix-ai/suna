# apps/api architecture

The API has five layers. A layer imports only from its own layer or a layer
below it. `eslint.config.mjs` enforces every rule on this page; its
`eslint-suppressions.json` records the violations that existed when a rule was
added, and those counts may only shrink.

```
 app       src/app/                 entry point, Hono app composition, boot and shutdown
   ↓
 http      src/http/                routes, middleware, OpenAPI, error handlers. Hono lives only here.
   ↓
 workers   src/workers/             every timer and leader-gated background loop
   ↓
 services  src/services/<name>/     domains: queries, provider calls, business rules
   ↓
 shared    src/lib/, src/types/     infrastructure and shared types; no domain imports
```

`src/__tests__/` and `src/scripts/` are outside the layers. Tests may import
anything they exercise; one-off scripts talk to a terminal.

## Folders

| Folder | Layer | Contents |
| --- | --- | --- |
| `src/app/` | app | `index.ts` (the process entry: `bun run src/app/index.ts`), `app.ts` (mounts every router in order), `bootstrap.ts` (starts replica services and leader-only workers, drains on shutdown), `inbound-dispatch.ts` (subdomain preview routing at the `Bun.serve` level), `ensure-schema.ts`. |
| `src/http/<domain>/` | http | The routes of one domain. A route parses input, calls a service, and shapes the response. |
| `src/http/middleware/` | http | Auth, CORS, compression, request deadline, rate limits, the Server-Timing middleware, the Actor bridge (`actor.ts`: `buildActor`, `actorFor`, `actorOf`). |
| `src/http/lib/` | http | Request readers shared by routes: `bearer.ts`, `http-body.ts`, client IP, caller session, project-access gates over the services' plain-value cores. |
| `src/http/openapi/` | http | `makeOpenApiApp`, shared schemas, the OpenAPI document. |
| `src/workers/` | workers | One file per loop: its timer state, start/stop, scheduling, and the `runWorkerTick('<name>', …)` call. The work of one tick is a service function. |
| `src/services/<name>/` | services | One folder per domain: `sessions`, `sandboxes` (with one folder per vendor: `daytona/`, `platinum/`, `e2b/`), `projects`, `git`, `github`, `triggers`, `secrets`, `attachments`, `audit`, `usage`, `billing`, `iam`, `connectors`, `channels`, `accounts`, … |
| `src/lib/` | shared | `config.ts`, `db.ts`, logger, crypto, validation, TTL memo, leader election, pg broadcast, backoff, request context, the object store client. |
| `src/types/` | shared | Types two layers share: `app-env.ts` (the Hono env), `rate-limit.ts`. |

## Rules

| Rule | What it checks |
| --- | --- |
| `kortix-api/layers` | No import goes up: shared → services → workers → http → app. |
| `kortix-api/service-surface` | Code outside `services/<name>/` imports that domain through `services/<name>/index.ts`. A domain without an `index.ts` adds one when it first needs a surface. |
| `no-restricted-imports` (http) | No `drizzle-orm` or `@kortix/db` in `src/http/`: queries live in services. |
| `no-restricted-imports` (below http) | No `hono` or `@hono/*` in `src/lib/`, `src/types/`, `src/services/`, `src/workers/`. A service takes plain values (an `Actor`, ids), never a request `Context`. |
| `kortix-api/replica-local` | A module-level empty `Map`/`Set` states why one replica's copy is correct (prod runs 3 replicas). |
| `no-console`, `no-restricted-properties` (`process.env`), `no-restricted-syntax` (`(c: any)`) | Unchanged from R0.3. |

## Routes are registered explicitly

A route module exports `register<Name>Routes()`. Nothing registers a route as a
side effect of being imported. The module that mounts a router calls its
register functions right before it mounts it (`app/app.ts`,
`http/accounts/index.ts`, `http/router/index.ts`). Hono dispatches in
registration order and `app.route()` copies routes when it is called, so the
order of those calls is the route order. `registerAllProjectRoutes()` in
`http/projects/index.ts` lists the project routes in the order production used
before the calls were explicit.

A test that mounts `projectsApp` itself calls `registerAllProjectRoutes()`.

## Adding code

- **A route:** a file in `src/http/<domain>/` exporting `register<Name>Routes()`, called from that domain's register list. Build the `Actor` with `actorOf(c, accountId)` and pass plain values to the service.
- **A service function:** in `src/services/<domain>/`. Export it from that domain's `index.ts` if another domain or layer calls it.
- **A background loop:** a file in `src/workers/` with `start…`/`stop…`, called from `app/bootstrap.ts` (`startSingletonWorkers` for leader-only work, `startReplicaServices` for every replica). Register its name in `src/__tests__/unit-worker-scope-wiring.test.ts`.
- **A function longer than 300 lines:** split it into named steps. None exist today.

## How the restructure was proven (R4, 2026-10-04)

Every move was a pure move: the ordered `app.routes` table (method, path,
handler arity and name, middleware included) was byte-identical before and
after, under the cloud profile (1,680 rows) and the self-host profile (1,692
rows), and `tests/spec/routes.generated.json` did not change.
