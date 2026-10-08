# Kortix Apps

Kortix Apps deploy static sites and HTTP applications from a project. Each App
has one stable URL. Each deployment is immutable. The active deployment pointer
changes only after the new deployment is ready.

Apps is experimental and off by default. Enable **Apps** for the selected
project under Project Settings → Experimental. The API returns `404`, the
public URL does not resolve, and App operations remain unavailable while the
feature is disabled. The CLI and web inventory stay visible and label Apps as
experimental.

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
a machine, with a run mode and a budget. Its build on Kortix never sees `.env*`
files, because the CLI never uploads them, so a build-time value such as
`VITE_*` in `.env.production` is missing from the result.

## Hosting

A deployment's `hosting_type` is `static` or `sandbox`. The App object reports
the active deployment's `hosting_type` (`null` before the first deploy).

**Static.** Kortix stores each file once per account under its SHA-256 and
serves the active deployment's files itself, after the App's access gate.
There is no machine, no cold start, and no compute bill. A deploy publishes
only changed files, and a rollback switches traffic at once.

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
  `always_on`, and `monthly_budget_usd`. A deploy that sets `env` or `secrets`
  records an `environment_ignored` event.
- `kortix apps start` and `kortix apps stop` answer
  `409 static_app_no_runtime`. A static App serves while it has an active
  deployment. Delete the App to take it offline.

**Server.** `bundle`, `dockerfile`, and `oci_image` build an image and run it
in one machine on a Kortix sandbox provider. Kortix chooses the provider. A
server App has a run mode, a machine, and a monthly budget.

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
| On demand (`always_on: false`, `--on-demand`) | Stops after `idle_timeout_seconds` without requests. The next authorized request wakes it. | Every App that only answers requests. |

A new App is always on unless `--on-demand` or `always_on: false` says
otherwise (operator default `KORTIX_APPS_DEFAULT_ALWAYS_ON`).

Every 5 minutes a keep-alive pass:

1. Stops every running server App (either mode) whose account can no longer
   pay for compute (`app_stopped_unfunded` event) or whose month-to-date
   compute reached `monthly_budget_usd` (`app_stopped_budget` event).
2. Asks the provider about each always-on App. A running App is billed for
   every hour it runs, with or without traffic. A stopped one is started again
   through the same entitlement, concurrency, and budget checks as a cold
   start.
3. Rebuilds at most 5 always-on Apps per pass whose App supervisor image is
   out of date.

**Budget.** A new always-on App with no `monthly_budget_usd` gets its
24/7 estimate rounded up to a whole dollar (74 for the default machine: 1 vCPU,
2 GiB, 10 GiB disk, about 73 USD a month at list compute rates). A derived
budget follows later machine and run-mode changes; one you set never changes.
An on-demand App gets `5`. The CLI prints `Runs 24/7 on 1 vCPU / 2 GB: about
$73/month (budget $74)`. The App object reports `estimated_monthly_usd`: its machine
running 24/7 for a month (`0` for a static App). When an always-on App's budget
is below that estimate, `create`, `set`, and `deploy` warn with
`app_budget_below_always_on` (stderr in the CLI, and a deployment event) and do
not refuse. Set the budget with `--budget <usd>` on `deploy` or `set`, or with
`monthly_budget_usd` in the manifest.

A run-mode or budget change through `kortix apps set` takes effect within 5
minutes, without a redeploy. A machine change applies to the next deployment.

**Provider.** On Platinum (Kortix Cloud), an always-on App's VM is persistent.
On Daytona and E2B (self-host), the VM keeps the provider's idle backstop and
keep-alive renews it. When the provider stops the VM anyway, keep-alive
restarts it within 5 minutes, so the App can be unreachable for up to 5
minutes.

## First deployment

From a linked project, build the App, then deploy its output directory:

```sh
kortix apps deploy ./dist --slug storefront --name Storefront --type static --spa
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

Use `--no-wait` only when another process will poll deployment state. The
default wait limit is 1,200 seconds. Change it with `--wait-seconds`.

## Repeatable v2 manifest

The `apps:` map is available only in `kortix_version: 2` YAML manifests.
It contains deployment defaults. It does not auto-deploy on merge.

```yaml
apps:
  storefront:
    path: web/dist
    type: static
    spa: true
  api:
    path: services/api
    type: dockerfile
    command: ["node", "server.js"]
    port: 3000
    readiness_path: /health
    always_on: false
    idle_timeout_seconds: 300
    monthly_budget_usd: 10
    resources:
      cpu: 1
      memory_gb: 2
      disk_gb: 10
    env:
      NODE_ENVIRONMENT: production
    secrets:
      DATABASE_URL: database-primary
```

An always-on server App sets a budget at or above its `estimated_monthly_usd`:

```yaml
apps:
  realtime:
    path: services/realtime
    type: dockerfile
    command: ["node", "server.js"]
    port: 3000
    always_on: true
    monthly_budget_usd: 80
```

Deploy one block:

```sh
kortix apps deploy --manifest-app storefront
```

When the manifest declares exactly one App, bare `kortix apps deploy` selects
it. CLI flags override manifest fields. A deploy with `--manifest-app` writes
the block's `resources`, `idle_timeout_seconds`, `always_on`, and
`monthly_budget_usd` to the App.

### Manifest fields

| Field | Meaning |
| --- | --- |
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
| `idle_timeout_seconds` | On-demand server Apps: stop after no traffic. Minimum `120`; default `300`. |
| `monthly_budget_usd` | Server Apps: monthly compute budget. Default: the 24/7 estimate rounded up to a whole dollar when always on, `5` on demand. |
| `resources` | Server Apps: `cpu`, `memory_gb`, and `disk_gb`. Defaults `1`, `2`, and `10`. |
| `env` | Server Apps: non-secret runtime key/value pairs. |
| `secrets` | Server Apps: runtime environment key to project secret **identifier** mapping. |

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

## Cold start and stop (server Apps)

An on-demand App's idle stop preserves the runtime. The next request starts the sandbox, waits
for readiness, and then proxies the request. Concurrent wake requests share one
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
building, provisioning, checking, starting, failed, cancelled, and budget
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
kortix apps show storefront
kortix apps rollback storefront <deployment-id>
```

Rollback accepts only a `ready` deployment. For a static App it changes the
active pointer at once. For a server App, Kortix starts and checks the target
runtime first. It then changes the active pointer and stops the previous
runtime. A target start failure leaves the previous deployment active.

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
| `402 app_budget_exceeded` | Increase the App budget (`kortix apps set <app> --budget <usd>`) or wait for the next monthly period. |
| `app_budget_below_always_on` warning | The always-on App will stop at its budget. Raise the budget to at least `estimated_monthly_usd`, or switch to `--on-demand`. |
| `402 app_account_unfunded` | The account cannot pay for compute. The App starts again once it can. |
| `429 app_concurrency_limit` | The account runs its maximum number of App runtimes. Stop another App. |
| `409 static_app_no_runtime` | A static App has nothing to start or stop. Delete the App to take it offline. |
| Repeated `202 app_starting` | Inspect deployment events and runtime logs. A healthy active deployment completes the same request after readiness. |

## Current boundaries

A server App supports one public HTTP port and one runtime per deployment. Its
process must answer HTTP at `readiness_path`: a process with no HTTP listener
never becomes ready. Apps do not support replicas, autoscaling, regions, UDP,
persistent volumes, private registry credentials, or custom domains.
The hosting provider is an infrastructure policy. Do not encode provider logic
in application code or the manifest.
