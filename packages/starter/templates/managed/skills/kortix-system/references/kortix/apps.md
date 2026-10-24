# Kortix Apps

Kortix Apps deploy static sites, HTTP servers, workers and backends from a
project. Each App has one stable URL. Each deploy creates
an immutable release (`vN`): the artifact plus its resolved config. Traffic
moves to a release only after its machines pass their checks. A server App
runs machines per process group; a machine may mount a volume that outlives
every release. The `kortix-apps` system skill covers releases, machines,
volumes, services, templates (`convex`), sign-in tokens and bindings
(`references/apps-model.md` there).

Apps are generally available in every project. Use Apps directly; no feature
flag or enablement request is required.

## Select a workload

| Source | Hosting | Use when | Required inputs |
| --- | --- | --- | --- |
| `static` | Static: files served by Kortix | The directory already contains HTML, CSS, JavaScript, and assets. | Directory. Optional `root`, `spa`. |
| `bundle` | Server: a machine | Kortix must run the install and build. | Directory. Optional install/build commands and output directory. |
| `dockerfile` | Server: a machine | The application runs an HTTP server or needs a custom build. | Build context, Dockerfile, command argv, target port. |
| `oci_image` | Server: a machine | A public image already contains the application. | Immutable image reference, command argv, target port. |

Auto-detection selects `dockerfile` when `Dockerfile` exists. It selects
`bundle` when `package.json` exists. It selects `static` otherwise. Pass
`--type` to override detection.

Prefer a local build deployed as `static` over `bundle`. A `bundle` App runs in
a machine and a run mode. Its build on Kortix never sees `.env*`
files, because the CLI never uploads them, so a build-time value such as
`VITE_*` in `.env.production` is missing from the result.

## Hosting

A deployment's `hosting_type` is `static` or `sandbox`. The App object reports
the active deployment's `hosting_type` (`null` before the first deploy).

**Static.** Kortix stores each file once per account under its SHA-256 and
serves the active deployment's files itself, after the App's access gate.
There is no machine, no cold start, and no compute bill. A deploy publishes
only changed files, and a rollback republishes stored files in seconds.

- Limits: 20,000 files per deployment, 50 MiB per file. A larger site fails
  with `invalid_site`.
- Path resolution: the exact file, then `<path>/index.html`, then
  `<path>.html`. With `spa`, a page navigation to an unknown path gets
  `index.html`. Otherwise `404.html` with status `404`, when it exists.
- Caching: HTML and other files revalidate on every request (ETag, `304`).
  Hashed build output (`_next/static/`, and hashed names under `assets/` or
  `static/js|css|media/`) is immutable for a year. Text is compressed with
  Brotli or gzip.
- Edge: a public App's immutable files are also cached at the Kortix edge for
  up to 1 hour. After a switch to non-public access or a delete, edge copies
  stay reachable by exact URL for up to 1 hour. Responses of a non-public App
  are `private` to shared caches.
- A static App ignores `env`, `secrets`, `resources`, `idle_timeout_seconds`,
  and `always_on`. A deploy that sets `env` or `secrets`
  records an `environment_ignored` event.
- `kortix apps start` and `kortix apps stop` answer
  `409 static_app_no_runtime`. A static App serves while it has an active
  deployment. Delete the App to take it offline.

**Server.** `bundle`, `dockerfile`, and `oci_image` build an image and run it
in machines on a Kortix sandbox provider: one per process group by default,
`kortix apps scale count` for more. Kortix chooses the provider. A server App
has a run mode, a machine size per group (`vm`) and optional volumes
(`mounts`).

Deployments with the same build inputs share one image: the artifact (archive
digest, or an OCI reference pinned with `@sha256:`), source settings,
Dockerfile, runtime spec, machine, and App supervisor version. Environment
variables and secrets are not build inputs. An env-only redeploy, an unchanged
redeploy, and a retry record `build_reused` and skip the build. An OCI tag is
pulled again on every deploy. A deployment that waits for another deployment
building the same image records `build_waiting`. When the provider refuses a
build for its template quota, Kortix deletes images no deployment uses and
builds once more; a second refusal fails the deployment with
`app_image_quota_exceeded`.

## Always on or on demand

| Mode | Behavior | Use it for |
| --- | --- | --- |
| Always on (`always_on: true`, `--always-on`) | Runs 24/7. Keep-alive restarts it within 5 minutes if it stops. | An App that holds websockets open or runs its own background loop. |
| On demand (`always_on: false`, `--on-demand`) | Stops after `idle_timeout_seconds` (120–86400) without requests. The next authorized request, or a trigger that calls the App, wakes it. A stop keeps the disk and loses memory. | Every App that only answers requests, and a poller a schedule calls (`run: { app, path }`). |

A new App is always on unless `--on-demand` or `always_on: false` says
otherwise (operator default `KORTIX_APPS_DEFAULT_ALWAYS_ON`).

Every 5 minutes a keep-alive pass:

1. Stops every running server App (either mode) whose account can no longer
   pay for compute (`app_stopped_unfunded` event).
2. Asks the provider about each always-on App. A running App is billed for
   every hour it runs, with or without traffic. A stopped one is started again
   through the same entitlement and concurrency checks as a cold start.
3. Rebuilds at most 5 always-on Apps per pass whose App supervisor image is
   out of date.

**Cost.** Apps have no monthly budget. Account credits pay for compute. The
account billing gate (`402`, for example `app_account_unfunded`) is the only
cost gate.

- On-demand server App: billed only while it is awake.
- Always-on server App: every machine bills 24/7, with or without traffic.
  The CLI prints `Runs 24/7 on 1 vCPU / 2 GB`. Tell the user the run mode;
  never quote a price.
- Static App: no machine, no compute. `always_on` is `false`.
- `--budget` is retired. The CLI prints `--budget is ignored: Apps have no
  budget.` and sends nothing. To use less compute, use `--on-demand` or a
  smaller machine.

A run-mode change through `kortix apps set` takes effect within 5
minutes, without a redeploy. A machine size change applies to the next
release: a new release with a new `vm` resizes without an image rebuild.

**Provider.** On Platinum (Kortix Cloud), an always-on App's VM is persistent.
On the legacy Daytona fallback (self-host), the VM keeps the provider's idle backstop and
keep-alive renews it. When the provider stops the VM anyway, keep-alive
restarts it within 5 minutes, so the App can be unreachable for up to 5
minutes.

## First deployment

From a linked project, build the App in its folder (`apps/<slug>/` by default),
then deploy its output directory:

```sh
npm --prefix apps/storefront run build
kortix apps deploy apps/storefront/dist --slug storefront --name Storefront --type static --spa --listed
```

The command performs these operations:

1. Creates the App if `--app` does not name an existing App.
2. Builds a deterministic `.tar.gz` for directory sources.
3. Registers an immutable artifact and uploads it through a signed URL.
4. Queues an immutable deployment.
5. Waits until the deployment is ready: a static App's files are published, or
   a server App's runtime passed readiness.
6. Prints the stable App URL.

The new App uses `private` access unless `--access` selects another mode.
It sits in the **Background** list unless `--listed` makes it a card on the
Apps page (see Listed and background Apps).

Use `--no-wait` only when another process will poll deployment state. The
default wait limit is 1,200 seconds. Change it with `--wait-seconds`.

## Repeatable v2 manifest

The `apps:` map is available only in `kortix_version: 2` YAML manifests.
kortix.yaml is the source of truth for each App's `resources`,
`idle_timeout_seconds`, `always_on`, `labels`, `display` and `uses`: a write
from the web, CLI, SDK or API commits to `apps.<slug>` first, and a push
applies them on sync without a deploy. Deleting an App removes its block.
The release config (`env`, `secrets`, `processes`, `http_service`,
`services`, `mounts`, `vm`, `deploy`) applies at the next deploy.

```yaml
apps:
  storefront:
    path: apps/storefront/dist
    type: static
    spa: true
    display: { listed: true }   # people open it: a card on the Apps page
  api:
    path: apps/api
    type: dockerfile
    command: ["node", "server.js"]
    port: 3000
    readiness_path: /health
    always_on: false
    idle_timeout_seconds: 300
    resources:
      cpu: 1
      memory_gb: 2
      disk_gb: 10
    env:
      NODE_ENVIRONMENT: production
    secrets:
      DATABASE_URL: database-primary
```

`monthly_budget_usd` is retired. The validator warns `is retired and ignored:
Apps have no budget. Remove it.` and the deploy ignores it. An always-on server
App:

```yaml
apps:
  realtime:
    path: apps/realtime
    type: dockerfile
    command: ["node", "server.js"]
    port: 3000
    always_on: true
```

Deploy one block:

```sh
kortix apps deploy --manifest-app storefront
```

When the manifest declares exactly one App, bare `kortix apps deploy` selects
it. With several, bare `deploy` deploys every block that has a `path` or
`image` and skips the rest. CLI flags override manifest fields. A deploy with
`--manifest-app` (and every sync of the file) writes the block's `resources`, `idle_timeout_seconds`, `always_on`, `labels` and `display` to
the App and sends the release config (`processes`, `http_service`,
`services`, `mounts`, `vm`, `deploy`). `kortix validate` refuses the same
config the API refuses.

A server App with a worker group, a second service and a volume:

```yaml
apps:
  api:
    path: apps/api
    type: dockerfile
    command: ["node", "server.js"]
    labels: [backend]
    processes:
      app: ""                       # the image's own command
      worker: "node worker.js"
    http_service:
      internal_port: 3000
      access: app                   # public | app | admins
      processes: [app]
      checks: [{ type: http, path: /health }]
    services:
      - { name: admin, internal_port: 3001, access: admins }
    mounts:
      - { source: data, destination: /data, initial_size_gb: 10, processes: [app] }
    vm:
      - { cpu: 1, memory_gb: 2 }
      - { cpu: 1, memory_gb: 1, processes: [worker] }
    deploy:
      release_command: "node migrate.js"
```

### Manifest fields

| Field | Meaning |
| --- | --- |
| `uses` | Apps of the project, by slug, this App uses: it may bind to them and mint their sign-in tokens. Replaces the App's list on every deploy and every sync of the file. |
| `path` | Source path relative to the manifest. Default `.`. |
| `type` | `static`, `bundle`, `dockerfile`, or `oci_image`. |
| `image` | Public OCI image reference. Required for `oci_image`. |
| `dockerfile` | Dockerfile path inside the archive. Default `Dockerfile`. |
| `command` | User-process argv. Required for Dockerfile and OCI sources. |
| `port` | User-process HTTP port. It cannot be `7331` or `8080`. |
| `root` | Static root inside the archive. |
| `output_dir` | Bundle build output. Default `dist`. |
| `install_command` | Bundle dependency installation command. |
| `build_command` | Bundle build command. Default `pnpm build`. |
| `spa` | Serve `index.html` for a page navigation to a path that does not exist. |
| `readiness_path` | Server Apps: HTTP path polled before activation. Default `/`. |
| `always_on` | Server Apps: `true` runs 24/7, `false` runs on demand. Default `true` for a new App. |
| `idle_timeout_seconds` | On-demand server Apps: stop after no traffic. `120`–`86400`; default `300`. |
| `resources` | Server Apps: `cpu`, `memory_gb`, and `disk_gb`. Defaults `1`, `2`, and `10`. |
| `env` | Server Apps: non-secret runtime key/value pairs. |
| `secrets` | Server Apps: runtime environment key to project secret **identifier** mapping. |
| `labels` | Free-form tags (for example `backend`). They group and filter Apps; no behavior depends on them. |
| `display` | Where Kortix shows the App; presentation only. `listed` (default `false`: the App sits in the **Background** list; `true` makes it a card on the Apps page), `preview` (`live`, the default, frames the App on its card; `none` shows an icon), `parent` (another App of the file: this App is a tab in its detail, not a card). Absent = the defaults. |
| `processes` | Process group name → shell command (`""` runs the image's own command). Default: one group, `app`. |
| `http_service` | The primary service: `internal_port`, `access` (`public`, `app`, `admins`), `auto_stop_machines` (`off`, `stop`, `suspend`), `auto_start_machines`, `min_machines_running`, `processes`, `checks`. `port` is the shorthand for `internal_port`. |
| `services` | More HTTP services, each `{ name, internal_port, access, processes }`, on `<App host>--<name>`. |
| `mounts` | Volumes: `{ source, destination, initial_size_gb, snapshot_retention_days, processes }`. At most 100 GB; not under a system directory. |
| `vm` | Machine size per group: `{ cpu, memory_gb, disk_gb, processes }` or a list of them. Overrides `resources`. |
| `deploy` | `strategy` (`bluegreen`, `rolling`, `immediate`, `canary`; default `rolling` with a mount, else `bluegreen`) and `release_command`. |

`kind` is retired: the validator warns, and an App's shape comes from its
config. `kortix apps launch --template convex` writes a ready-made backend.

## Secrets and environment

Never place a secret value under `apps.<name>.env`. Use a project secret and map
its identifier:

```yaml
apps:
  api:
    secrets:
      STRIPE_API_KEY: stripe-production
```

Only a server App reads `env` and `secrets`. The deployment record stores
`STRIPE_API_KEY -> stripe-production`. The API
decrypts the current secret only when it creates the runtime. The value does
not enter the archive, build context, image, deployment record, CLI output, or
App logs.

The destination key cannot be a control key such as `PORT`, `PATH`,
`KORTIX_*`, or `OPENCODE_*`. A missing identifier fails deployment with
`invalid_environment`. Only an **environment**-exposure secret (`strategy:
runtime`) can become an App environment value. An egress-enforced, service-spent,
or disabled secret is rejected with the same code — an App runtime is not behind
the egress relay, so there is nothing to substitute its handle.

## Access

```sh
kortix apps access storefront
kortix apps access storefront --mode private
kortix apps access storefront --mode project
kortix apps access storefront --mode restricted --members <member-id> --groups <group-id>
kortix apps access storefront --mode public
kortix apps access storefront --mode password --password '<value>'
```

| Mode | Subjects |
| --- | --- |
| `private` | The App creator. This is the default. |
| `project` | Every current project reader. |
| `restricted` | The selected project members and groups. |
| `public` | Anyone. |
| `password` | Anyone who supplies the App password. |

`kortix apps ls`, the Apps list API (`GET /v1/projects/:projectId/apps`), the SDK
and the web grid list only the Apps the caller may open. Private: the creator.
Restricted: the listed members and groups. Other modes: the project team. A
project manager sees every App. `viewer_can_access` is `true` on every listed
App. A `GET` of an App the caller cannot open answers `404`.

`kortix apps deploy` accepts the same `--access`, `--password`, `--members`,
and `--groups` flags. Never store a password in `kortix.yaml` or a source file.
Kortix stores only an Argon2id hash.

Kortix-authenticated users open a five-minute exchange URL. It creates an
eight-hour, secure, host-only cookie for that App hostname. A policy update
revokes existing cookies.

## Acting as the viewer

An App that calls the Kortix API for each person who opens it (a chat, a
per-user dashboard) must act as that person, never as one shared key.

```sh
kortix apps access <app> --viewer api
```

- `--viewer identity` (default) signs the viewer's id, email, and groups into
  every request (`x-kortix-app-viewer`). `--viewer api` also sends a one-hour
  token that acts as them (`x-kortix-app-viewer-token`). `--viewer off` sends
  neither.
- On the App's server, build one client per request:
  `createAppViewerKortix(request, { backendUrl })` from `@kortix/sdk/server`.
  Do not store the token across requests.
- In the browser (a static App has no server), call the API through the gate
  on the App's own origin:
  `createKortix({ backendUrl: '/_kortix/api/v1', getToken: kortixAppViewerToken() })`
  from `@kortix/sdk`. The API refuses an App origin's CORS preflight, so a
  direct call to the Kortix API origin fails. The gate path needs
  `--viewer api` and answers `403 viewer_api_disabled` without it.
- Never give the App a personal PAT or API key to run every viewer's sessions.
  Kortix records each session as the credential's owner, so every viewer's
  chat becomes that one person's private session.
- The token holds the viewer's own role. On a project with agent permissions,
  grant viewers the agent the App starts, or session creation answers
  `403 no_agent_access`.
- Never log the viewer headers. Kortix already leaves request headers out of
  `kortix apps logs`.

Create an authenticated browser link through the CLI:

```sh
kortix apps access-link storefront --json
```

The response contains `app.url`, `access_session.url`, and
`access_session.expires_at`. The exchange URL is valid for five minutes. Treat
it as a secret. Its first request sets the eight-hour App-host cookie and
redirects to the same path without the token. Create a fresh link for each
independent browser profile or cookie jar.

## Archive rules

Directory deployments read these files, in order:

1. `.gitignore`
2. `.dockerignore`
3. `.kortixignore`

The packer always excludes `.git`, `.kortix`, and `.env*` at every depth.
It excludes `node_modules` unless `--include-node-modules` is set. Mandatory
exclusions cannot be re-included by a negated ignore pattern.

Archive limits:

- Compressed: 250 MiB.
- Extracted: 1 GiB.
- Files: 100,000.
- Path: 1,024 bytes.

Extraction rejects absolute paths, parent traversal, devices, FIFOs, and links
that escape the build context.

## Runtime and network (server Apps)

The App sandbox contains `kortix-appd` and Caddy. `kortix-appd` owns the user
process, readiness, restarts, logs, and signals. Caddy owns public HTTP, SSE,
streaming responses, and WebSockets.

- Public ingress port: `8080`.
- Private control port: `7331`.
- User target port: the declared `port`.
- User process restarts: up to 3 by default.
- Readiness timeout: 120 seconds.

The user process never receives the runtime control token. Provider credentials
never enter the App environment.

## Listed and background Apps

An App is a card on the Apps page only with `display.listed: true`
(`--listed`, or Settings → "Show on Apps page"). Every other App sits in the
**Background** list: status, kind, run mode, what calls it and its last
activity. Opening a background App shows its overview (how it runs, what
calls it, which agents it starts, size, URL, version); **Open** shows its page.
An external App (`kortix apps create <slug> --url <https-url>`) is listed on
create. Deploy an App people open (a site, a UI, a dashboard) with
`--listed`; leave backends, workers and pollers unlisted.

## App events, App targets and scheduled runs

A server App reports what it sees by posting **App events** to
`$KORTIX_APP_EVENTS_URL` with `Authorization: Bearer $KORTIX_APP_TOKEN`
(`$KORTIX_APP_ID` is its id). A trigger (`on: { event, app }`) decides which
agent runs; the App never starts an agent itself. A trigger with
`run: { app, path }` calls the App on a schedule or an event, waking an
on-demand App. The App can also schedule its own later call with
`POST …/apps/<app_id>/runs`. Formats, limits and the order of preference:
`references/scheduling.md` → App events, Call an App, App-scheduled runs.

## Cold start and stop (server Apps)

An on-demand App's idle stop keeps the disk and loses memory. The next
request, or a trigger that calls the App, starts the machine, waits for
readiness, and then sends the request. Concurrent wake requests share one
database lease.

`kortix apps stop <app>` suspends compute immediately, in either mode, and
keep-alive leaves the App stopped. The next authorized request resumes the
active runtime, waits for readiness, and then returns the App response for that
same request. `kortix apps start <app>` warms the active runtime before an
authorized request arrives.

Every request extends the activity lease and idle deadline. Streaming responses
renew the lease until the response ends. WebSocket connections renew it while
the socket remains open.

Browser navigation shows a Kortix lifecycle page during queued, validating,
building, provisioning, checking, starting, failed, and cancelled
states. Machine clients receive `202 app_starting` with `Retry-After: 3` during
a transient cold start. A healthy App never exposes `app_stopped` or an
unavailable cold-start state.

Browser navigations receive branded HTML with the same `202` status and a
three-second refresh while starting. The Apps UI lives at
`/projects/<project-id>/apps`. Its iframe uses an authenticated App access
session and wakes a suspended private App.

When a Kortix release changes the App supervisor image (`kortix-appd` and
Caddy), Kortix queues one immutable replacement of the same artifact: on the
next cold start of an on-demand App, or in a keep-alive pass for an always-on
App. The active deployment keeps serving until the replacement passes
readiness. A release that changes only the API rebuilds nothing. A failed
replacement is not retried for the same artifact and image after a build or
site error, and at most once an hour after a provider error.

## Versions and rollback

```sh
kortix apps releases storefront
kortix apps rollback storefront v3
```

Rollback accepts only a `ready` release. It creates a NEW release (the next
version) from the target's artifact and config and rolls it out like a deploy
(`202`). A static App's new release publishes in seconds: its files are already
stored. A server App's new release rolls out on its strategy; volumes keep
their data. A new release that never gets healthy is abandoned: the previous
release keeps serving.

Retention: an App keeps its active deployment and the 5 newest other ready
deployments (`KORTIX_APPS_RETAINED_DEPLOYMENTS`). After each deploy, Kortix
retires older ready deployments: their runtime, image (once no other
deployment uses it), static files, and build-log lines are freed, and they
leave `show` and the deployment list.
Lifecycle events stay. A failed or cancelled deployment keeps its build log for
14 days. Delete one deployment yourself with
`kortix apps delete <app> --deployment <id|vN> --yes`. The live deployment
answers `409 deployment_live`.

## Logs and diagnosis

```sh
kortix apps logs storefront
kortix apps logs storefront <deployment-id> --after 100 --limit 500
```

Deployment events explain validation, build, publishing, provisioning,
readiness, retries, activation, and rollback. A server App's runtime logs
contain separate `app`, `appd`, and `caddy` sources. A static App has no
runtime: `kortix apps logs` prints its deployment events, one per line, as
`<time> kortix  [<event type>] <message>`. Secret values are not included by the control plane. User code
can still print values it receives; treat application logs as sensitive.

Common failures:

| Code or symptom | Action |
| --- | --- |
| `invalid_spec` | Check relative paths, command argv, target port, and readiness path. |
| `invalid_site` | A static root that is missing or empty, more than 20,000 files, or a file over 50 MiB. Fix the output directory. |
| `invalid_environment` | Check destination keys and project secret identifiers. |
| `digest_mismatch` / `size_mismatch` | Re-upload the archive. Do not reuse corrupted bytes. |
| `provider_disabled` | Omit `--provider` or select an enabled provider. |
| Readiness timeout | Make the process bind the declared port and return success at `readiness_path`. |
| `402 app_account_unfunded` | The account cannot pay for compute. The App starts again once it can. |
| `429 app_concurrency_limit` | The account runs its maximum number of App runtimes. Stop another App. |
| `409 static_app_no_runtime` | A static App has nothing to start or stop. Delete the App to take it offline. |
| Repeated `202 app_starting` | Inspect deployment events and runtime logs. A healthy active deployment completes the same request after readiness. |

## Current boundaries

A server App supports HTTP services (each on its own host), process groups,
up to 20 machines per group and one volume per machine (at most 100 GB). A group
with no service is a worker and is never idle-stopped. Apps do not support
TCP or UDP services, private networking between Apps, autoscaling, regions,
private registry credentials, or custom domains.
The hosting provider is an infrastructure policy. Do not encode provider logic
in application code or the manifest.
