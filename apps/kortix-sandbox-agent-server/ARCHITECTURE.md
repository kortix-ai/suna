# kortixd architecture

kortixd has four layers. A layer imports only from the layers below it.
`eslint.config.mjs` enforces every rule on this page, and
`scripts/check-architecture.mjs` proves that each rule allows and rejects what
this page says.

```
 app       src/main.ts, src/app/, src/routes/     composition root and HTTP controllers
   ↓
 harness   src/harness/                           the session runtime: OpenCode and pi, isolated from each other
   ↓
 services  src/services/<name>/                   host capabilities; each declares the other services it uses
   ↓
 shared    src/lib/, src/types/                   building blocks and shared types; no service state, no Hono
```

A layer is a set of folders, not a folder. The shared layer is `src/lib/` plus
`src/types/`; `eslint.config.mjs` names that set `{sharedLayer}`.

Why the harness is a layer of its own: it composes the services. It imports 8
of them (`config-release`, `runtime-assets`, `sandbox-env`, `event-bus`,
`llm-proxy`, `resources`, `skills`, `config-provider`), and no service imports
it. It sits above the services for the same reason the services sit above the
shared layer.

## Folders

| Folder | Layer | Contents |
| --- | --- | --- |
| `src/main.ts` | app | Entry point. Builds the config, the harness boot context and the HTTP `serve` function. |
| `src/app/` | app | `server.ts` (Hono app, auth gate, route mounting), `shutdown.ts`, `monitor-mode.ts`, `cli.ts` (management CLI). |
| `src/routes/kortix/` | app | `/kortix/*`: health, refresh, config, catalog, abort, env, part, logs, diag, the Runtime API (`/kortix/runtime/*`, also mounted at its pre-W3 path `/kortix/opencode/*`), pty, env-rpc, git. Each route checks its own credential. `legacy-names.ts` holds every pre-W3 wire name the routes still answer and accept. |
| `src/routes/workspace/` | app | `/file`, `/find`, `/presentation`: daemon-owned access to `/workspace`, behind the user-context gate. |
| `src/routes/proxy/` | app | `/proxy/:port`, `/web-proxy`, and the catch-all to the harness, behind the user-context gate. |
| `src/harness/` | harness | `harness.ts` (resolver, `loadConfig`, boot context), `contract/` (ports app and routes call), `shared/` (steps both adapters run), `open-code/`, `pi/`. See its [README](src/harness/README.md). |
| `src/services/config-provider/` | services | Project acquisition: `git`, `prefer-s3`, `require-s3`. |
| `src/services/config-release/` | services | The config-release store outside the repository, its descriptor, notice and API calls. |
| `src/services/runtime-assets/` | services | CLI, agent, skill-overlay and harness-asset convergence (self-update); the runtime-truth ledger. `port.ts` is the contract a harness implements. |
| `src/services/egress-shim/` | services | The in-guest egress proxy that substitutes secret handles. |
| `src/services/llm-proxy/` | services | Localhost credential-injecting proxies to the LLM gateway and connectors; the inline-image window. |
| `src/services/sandbox-env/` | services | The project env store and the secret-capability instruction file. |
| `src/services/skills/` | services | Image-baked managed Kortix skills and their injection. |
| `src/services/static-web/` | services | The static file server on port 3211. |
| `src/services/tools/` | services | The hosted tools: the Kortix tools (`kortix/`: `web_search`, `image_search`, `scrape_webpage`, `memory`, `show`) and the project's kortix.yaml `tools`, one module each, run the same way by every harness. A project with a `tools` key gets only the Kortix tools it lists. |
| `src/services/monitor/` | services | The monitor process runner for monitor boxes. |
| `src/services/event-bus/` | services | The daemon event sequencer. |
| `src/services/resources/` | services | Box resource telemetry (memory, cgroup, load, disk, RSS). |
| `src/lib/config/` | shared | Host env parsing (`loadHostConfig`), manifest reads, the runtime state directory. |
| `src/lib/log/` | shared | The daemon logger and log tailing. |
| `src/lib/git/` | shared | The git runner, identity, credential helper, project materialization and compiled checkouts. |
| `src/lib/kortix-api/` | shared | Control-plane contracts: relay context, `X-Kortix-User-Context` verification, the dead-token breaker. |
| `src/lib/shutdown-state.ts` | shared | The process-wide "shutting down" flag. |
| `src/types/` | shared | Types two modules need that may not import each other: `control-plane.ts` (`InitialTurnClaim`), `config-release.ts` (`ConfigReleaseReport`). Type declarations only. |
| `src/__tests__/` | none | Tests. They may import anything they exercise. |

## Import rules

| Files | May import | Packages beyond `node:*`, `bun`, `zod`, `tar` |
| --- | --- | --- |
| `src/types/**` | `src/types/**` | none, and no runtime code at all |
| `src/lib/**` | the shared layer | none |
| `src/services/<name>/**` | its own folder, the services `SERVICES` declares for it, the shared layer | `egress-shim`: `node-forge`, `@kortix/api-contract`. `monitor`, `runtime-assets`, `tools`: `@kortix/api-contract` |
| `src/harness/harness.ts` | the harness, all services, the shared layer | none |
| `src/harness/{open-code,pi}/**` | its own folder, `harness.ts`, `contract/`, `shared/`, all services, the shared layer | `@kortix/api-contract`. `open-code`: `bun:sqlite`. `pi`: `@earendil-works/*`, `typebox`, `@kortix/sdk/wire-message-id` |
| `src/harness/{contract,shared}/**` | `harness.ts`, `contract/`, `shared/`, all services, the shared layer | `@kortix/api-contract` (the daemon-to-API wire, `runtime-relay`) |
| `src/routes/**` | `src/routes/**`, `harness.ts`, `contract/`, `shared/`, all services, the shared layer | `hono`, `@kortix/api-contract` |
| `src/app/**`, `src/main.ts` | everything above except adapter internals | `hono`, `@kortix/api-contract` |
| anything else under `src/` | nothing: a file outside every layer fails the lint | — |

Consequences:

- Only `src/harness/harness.ts` imports an adapter. An adapter never imports
  another adapter, a route, or `src/app/`.
- No service imports the harness.
- Hono lives only in `src/routes/` and `src/app/`.
- pi's packages load only from `src/harness/pi/`, so an OpenCode boot never pays
  for them.
- A service imports another service only through a declared edge. Today there
  are two: `runtime-assets` → `config-release` (`withReleaseStoreLock`) and
  `config-release` → `skills` (`managedSkillsDir`).
- `src/types/` declares types and nothing that exists at runtime (no variable,
  function, class, enum, namespace, default export or statement). Importing a
  shared type never pulls code or a module graph into the importer.
- Type-only imports, dynamic `import()` and `export * from` count the same as
  value imports.

## Import style

`@/` is `src/` (a `tsconfig.json` path; Bun resolves it in `bun run`, `bun test`,
`mock.module` and `bun build`). An import that crosses a top-level folder of
`src/` uses it; an import inside one folder stays relative:

```ts
// src/harness/pi/boot.ts
import { materializeProject } from '@/services/config-provider/config-provider' // another folder
import { runSandboxOnBoot } from '../shared/on-boot'                             // same folder: harness/
```

The folders are `app`, `routes`, `harness`, `services`, `lib`, `types` and
`__tests__`; `src/main.ts` stands alone, so everything it imports uses `@/`. A
path outside `src/` (another package, `package.json`) stays relative. The
`kortixd/import-style` lint rule enforces both directions and fixes them:
`bun run lint --fix`.

No other package imports or reads `src/`, and `src/` imports no other app
(`tests/unit/kortixd-package-boundary.test.ts`). A value the daemon shares with
apps/api, the CLI or `@kortix/shared` lives in `packages/api-contract` and both
sides import it. The daemon reaches those files, and the SDK's import-free
`wire-message-id.ts`, through tsconfig paths. `KORTIXD_SHARED_SOURCES`
(`@kortix/api-contract/sandbox-layout`) lists them: apps/api fingerprints them
with this source, and the Dockerfiles copy them (`src/__tests__/shared-sources.test.ts`).

## OpenCode names (E18 ratchet)

OpenCode knowledge belongs in `src/harness/open-code/`. The `kortixd/opencode-names`
lint rule rejects an identifier or string that matches `/open.?code/i` in
`src/lib/`, `src/types/`, `src/services/`, `src/routes/`, `src/app/`,
`src/main.ts`, `src/harness/contract/`, `src/harness/shared/` and, since W5 E2
(pi emits the Kortix format), `src/harness/pi/`. Tests, `src/harness/harness.ts`
and the OpenCode adapter are out of scope. Comments are not checked.

`OPENCODE_NAMES_ALLOWED` in `eslint.config.mjs` lists the names that exist
today, per file. The list only shrinks: an entry whose word no longer occurs in
its file fails the lint, so the PR that removes a name deletes its entry. Do not
add an entry; name the new code neutrally or move it into the adapter.

Since W3 the list holds one file, `src/routes/kortix/legacy-names.ts`: the
pre-W3 wire names (`opencode_pid`, `opencodeEnv`, `/kortix/opencode`, …) that an
API deploy built before W3 still reads and sends. Every other module uses the
Kortix names (`runtime_*`, `runtime_session_id`, `harness_version`). Delete the
file, its callers' spreads and its entry when no such API deploy can run. The
two pi entries (`src/harness/pi/config.ts`, `config-release.ts`) name the legacy
layout's config directory, `.kortix/opencode`, which a project that has not
moved to the root layout still uses.

## Where a type goes

1. A type its consumers may already import stays with its owner. The harness
   ports stay in `src/harness/contract/`, next to what implements them; every
   adapter, route and `src/app/` may import them.
2. A type that two modules need and that neither may import from the other goes
   to `src/types/`: two adapters, a service and an adapter, or two services.
   Move it, point every user at it, and delete the copies.
3. A type the API also uses goes to `packages/api-contract`, not `src/types/`.

`src/types/` files are named by the contract they describe, not collected in
one file. A constants folder joins the shared layer by the same rule, with its
first constant that has no owning module; there is none today.

## When a lower layer needs something from a higher one

Do not import it. The higher layer hands it down:

- An adapter's boot starts the HTTP server through `HarnessBootContext.serve`,
  which `src/main.ts` builds from `startProxy` and `installShutdownHandlers`.
- `runtime-assets` finds the harness assets through `registerHarnessAssets`,
  which `src/main.ts` calls before anything runs.
- `startStaticWebServer` receives the protected paths
  (`harnessProtectedPathSegments()`) as a parameter.
- A process-wide fact that several layers read (the shutdown flag) lives in
  `src/lib/`. A shape several layers read lives in `src/types/`.

## Where new code goes

1. It handles an HTTP request: `src/routes/<zone>/`, by URL. A helper that only
   routes use sits next to them.
2. It wires startup, shutdown or a workload: `src/app/`.
3. It is harness-specific: `src/harness/<adapter>/`. Both adapters need it:
   `src/harness/shared/`. App or routes call it: a port in
   `src/harness/contract/`.
4. It is a host capability with its own state or lifecycle: an existing
   service, or a new `src/services/<name>/`.
5. It is a stateless building block with no product state and no Hono:
   `src/lib/`. It is a type two isolated modules share: `src/types/`.

A file lives next to its only consumer. Move it down to `shared/`, `src/lib/`
or `src/types/` only when a second consumer exists. Then move the
implementation, update every importer and test, and delete the old path in the
same change.

## Changing a boundary

Change the rule, the proof and this page in the same PR:

- **New service:** create `src/services/<name>/` and add `<name>: []` to
  `SERVICES` in `eslint.config.mjs`.
- **New service-to-service edge:** add the dependency to that service's
  `SERVICES` entry with a comment that names the function it needs, add an
  allowed case to `scripts/check-architecture.mjs`, and list it above.
- **New adapter:** create `src/harness/<id>/`, add it to `ADAPTERS`, and
  register it in `resolveHarness`.
- **New shared folder** (for example a constants folder): add it to
  `sharedLayer`, give it its own `layer(...)` entry, and add cases.
- **New npm package:** allow it in `RUNTIME` (every layer) or in one layer's
  list, in both forms (`pkg('<name>')`).

Never disable `project-structure/independent-modules` or the `src/types/`
`no-restricted-syntax` rule. When one fires, move the code, or hand the lower
layer what it needs from the layer above.

## Checks

| Command | What it checks |
| --- | --- |
| `bun run lint` | The import rules and the import style over `src/` (`--fix` rewrites the style). |
| `bun run test:architecture` | Each rule allows and rejects its cases; the docs name paths that exist. |
| `bun test` | Everything, including `src/__tests__/architecture-boundaries.test.ts`, which runs the two commands above. |

The CI job `sandbox-agent-build` (`.github/workflows/ci.yml`) runs `bun run lint`
and `bun run test:architecture` on every pull request that touches this app.

## Plugin behavior the config depends on

`eslint-plugin-project-structure` has 5 behaviors that `eslint.config.mjs`
and `package.json` work around. Each one was measured, not assumed:

- It resolves every pattern against the directory above the first
  `node_modules` in its own real path, and has no option to change that. pnpm
  links it from the monorepo root; `bun install` in this directory installs it
  here. The config prefixes every pattern, `packageRoot` and the
  `@kortix/api-contract` alias with this package's path from that root, so both
  layouts check the same files. Setting `pathAliases.baseUrl` to that path
  instead silently disables the rule.
- It records some packages bare (`hono`) and others as a declaration path
  (`zod/index.d.ts`). `pkg()` allows both forms.
- It treats `node:*` built-ins as packages and looks for `node_modules/@types/node`
  in its root and in `packageRoot`. A clean pnpm install links only declared
  dependencies there, so `@types/node` is a declared devDependency. Without it,
  every `node:*` import reports `Cannot find module`. A bare built-in name
  (`crypto`, `fs`) does not resolve under pnpm even then, so a
  `no-restricted-imports` rule rejects it and names the `node:` form. It is
  declared `^20`, like apps/web, so pnpm keeps one `@types/node` for the
  monorepo (the `^22` catalog entry moves 18 transitive `@types/*` packages).
- A tsconfig-aliased file outside the plugin root (`@kortix/api-contract`)
  arrives as an absolute path. The egress-shim entry allows the absolute and the
  root-relative form.
- ESLint's config validation crashes under the Bun runtime. Run ESLint and the
  contract script under Node (`bun run lint` does, through the `eslint` bin's
  shebang).
