---
name: kortix-apps
description: "Deploy and operate Kortix Apps through the pre-authenticated CLI or SDK. Use when the user asks to publish, host, deploy, preview, inspect, wake, suspend, roll back, debug, or remove HTML/CSS/JavaScript, a static SPA, Vite or React source, Next.js, a Dockerfile service, or an OCI image on a stable Kortix URL, or asks what an App costs or how it runs."
---

# Kortix Apps

Kortix Apps turns one directory or image into an immutable deployment with a
stable URL. There are two kinds:

- A **static App** is files. Kortix stores them and serves them itself: no
  machine, no cold start, no compute bill, instant rollback.
- A **server App** (a Dockerfile or an OCI image) runs in its own machine. It
  has a run mode (always on or on demand) and a monthly compute budget.

Kortix chooses and operates the provider. Never select Cloudflare, Vercel, or
another host for an App. Omit `--provider` unless an operator asks for one.

## Preflight

1. Run `pwd` and inspect the intended source directory before deploying.
2. Run `kortix projects info --json` to confirm the selected project. Read its
   identifier from `project_id`.
3. If Apps is disabled, ask a project manager to enable the Experimental Apps
   feature. API and CLI execution are project-gated.
4. Do not create an empty App identity first. `kortix apps deploy` creates the
   identity when `--app` is omitted.
5. Never run `kortix apps deploy` from an uninspected workspace root. It can
   publish unrelated files as a static App.
6. New Apps are private. Choose another access mode only when the user asks.

## Select the source type

Default to static. Use a server App only when the App needs its own server
process.

| Source | Preferred deployment |
| --- | --- |
| HTML, CSS, JavaScript | `--type static` |
| Prebuilt Vite or React `dist/` | deploy `dist/ --type static --spa` |
| Vite or React source | build it here (`npm run build`), then deploy `dist/ --type static --spa` |
| Next.js static export | set `output: 'export'`, build, then deploy `out/ --type static --spa` |
| Next.js server runtime | Dockerfile, command, and port `3000` |
| Any custom HTTP service | Dockerfile, command, and target port |
| Existing public container image | `--image`, command, and target port |

A frontend that talks to a Kortix Backend is static. Use a Dockerfile only when
the App needs a server process, native packages, or custom runtime behavior.

Build here, then deploy the output directory itself as the path
(`kortix apps deploy ./dist`):

- The CLI reads `.gitignore`, `.dockerignore`, and `.kortixignore` only from the
  directory it uploads. A repository `.gitignore` that lists `dist/` does not
  hide `./dist` when `./dist` is the path.
- The CLI never uploads `.env*` files. A build-time value (`VITE_*` or
  `NEXT_PUBLIC_*` in `.env.production`) reaches the App only through a build
  you ran here, before the deploy.
- Keep `dist/` and `out/` in the repository's `.gitignore`. Committed build
  output bloats the repository every session clones (`kortix validate` warns).
- A static App holds at most 20,000 files of at most 50 MiB each. A larger
  site fails with `invalid_site`.
- A static publish never serves `.git/`, `.env*` or `.DS_Store`, at any depth,
  even when an SDK or API upload contains them. The `site_published` log line
  counts what it left out.
- A symlink in the upload that resolves outside it fails the deploy
  (`escapes the build context`). Links inside the upload are kept.

Static caching: HTML and every other file revalidate on each request (ETag,
`304`). Build output with a content hash in its name is immutable for a year:
`_next/static/`, and files under `assets/` or `static/js|css|media/` named like
`index-D8j1YYcB.js`. Never overwrite such a file in place; let the bundler
rename it. A public App's immutable files are also cached at the Kortix edge.
After a switch to private or a delete, edge copies stay reachable by exact URL
for up to 1 hour. A directory URL without its slash (`/docs`) redirects `308`
to `/docs/`, so relative links in `docs/index.html` resolve. Files over 4 MiB
are served uncompressed and support `Range` requests.

Before building generated output, inspect `package.json` and the lockfile. Run
the declared `build` script with the repository's package manager. Do not assume
`pnpm` when the project uses npm, Yarn, or Bun.

## Deploy

Deploy a new App and block until its stable URL is ready:

```bash
kortix apps deploy ./dist --slug storefront --name Storefront --type static --spa
```

Deploy a Dockerfile service that only answers requests (choose the run mode
and budget on the first deploy; see Lifecycle):

```bash
kortix apps deploy . --slug api --type dockerfile --on-demand \
  --command '["node","server.js"]' --port 3000 --readiness-path /health
```

Deploy an OCI image:

```bash
kortix apps deploy --image nginx:1.27-alpine --slug nginx \
  --command '["nginx","-g","daemon off;"]' --port 80
```

The command waits for `ready` for up to 1200 seconds. Use `--no-wait` only when
another process owns status tracking.

Use `--app <id-or-slug>` for every later immutable version of the same App.
Never create a new slug for a normal update.

## Access

```bash
kortix apps access <app>
kortix apps access <app> --mode private
kortix apps access <app> --mode project
kortix apps access <app> --mode restricted --members <member-id> --groups <group-id>
kortix apps access <app> --mode password --password '<value>'
kortix apps access <app> --mode public
```

- `private` allows only the App creator. It is the default.
- `project` allows every current project reader.
- `restricted` allows selected project members and groups.
- `password` allows anyone who knows the App password.
- `public` requires no authentication.

Use the equivalent `--access`, `--members`, `--groups`, and `--password` flags
on the first deploy when the user requested non-default access. Never write a
password into `kortix.yaml`, source, logs, or a command shown to another user.
Kortix stores only an Argon2id hash. A policy update revokes existing App
browser sessions.

## Acting as the viewer

An App that calls the Kortix API for each person who opens it (a chat, a
per-user dashboard) must act as that person, never as one shared key.

```bash
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
  from `@kortix/sdk`. Never use `https://api.kortix.com/v1` from the browser:
  the API refuses an App origin's CORS preflight. The gate path needs
  `--viewer api` and answers `403 viewer_api_disabled` without it.
- Never give the App a personal PAT or API key to run every viewer's sessions.
  Kortix records each session as the credential's owner, so every viewer's
  chat becomes that one person's private session.
- The token holds the viewer's own role. On a project with agent permissions,
  grant viewers the agent the App starts, or session creation answers
  `403 no_agent_access`.
- Never log the viewer headers. Kortix already leaves request headers out of
  `kortix apps logs`.

Create a short-lived authenticated browser link without changing the policy:

```bash
kortix apps access-link <app> --json
```

Read the stable URL from `app.url`. Read the signed URL and expiry from
`access_session.url` and `access_session.expires_at`. The signed URL is valid for
five minutes. Treat it as a password until it expires. Do not publish it, commit
it, or put it in logs. The first request exchanges it for an eight-hour
App-host cookie and redirects to the same path without the token. Create a fresh
link for each independent browser profile or cookie jar.

## Verify

Do not stop at a `ready` status.

1. Read the App and deployment ledger:

   ```bash
   kortix apps show <slug> --json
   ```

   `hosting_type` is `static` for a static App and `sandbox` for a server App.
   For a server App, confirm `always_on` and `monthly_budget_usd` are the values
   you chose. When `always_on` is `true`, `monthly_budget_usd` should be at least
   `estimated_monthly_usd` (the default already is).

Every App:

2. Read the stable URL from `app.url` in the `deploy`, `show`, or `access-link`
   JSON result. Fetch it. For a private App, create an authenticated link with
   `kortix apps access-link <slug> --json`, follow redirects, and retain the
   response cookie. Assert status `200`, the expected body marker, and the
   content type.
3. For generated static output, discover an actual `src` or stylesheet `href`
   in the returned HTML. Resolve the relative URL against the stable App URL and
   fetch that hashed JavaScript or CSS asset. Assert status `200` and its content
   type. Do not guess the hashed filename.
4. For an SPA, fetch a client route. Confirm it returns the same root marker and
   hashed entry asset as `/`. Byte equality is also valid when the server does
   not inject per-request content.
5. For non-public Apps, fetch the stable URL without credentials and confirm it
   returns `401` before testing authorized access.

A static App is verified here: it has no runtime to stop or wake. A server App
continues:

6. Fetch its readiness endpoint and one real application route.
7. Run `kortix apps stop <slug> --json`. The command returns only after the
   provider stop call and runtime-state write complete. Confirm
   `desired_state` is `stopped`. Request the stable URL with the existing
   App-host cookie without running `start`.
   Poll for up to 120 seconds until the final response is `200`. A machine
   response can return `202` with `Retry-After: 3` while the provider resumes.
   A browser navigation receives the same `202` with branded HTML and a
   three-second refresh. The body must never expose `app_stopped`, `App not
   found`, `temporarily unavailable`, or `App is temporarily unavailable`.
8. Re-read `kortix apps show <slug> --json`. Confirm the active deployment did
   not change during a normal wake. If it changed, require the new active
   deployment to be `ready`, `actor_type: system`, `source_session_id: null`,
   and to reuse the prior `artifact_id`, `source_kind`, and `hosting_provider`.
   Those fields identify a background runtime refresh.

Only when the user asks to see the App inside Kortix:

9. Reuse a browser profile that is already signed in to Kortix as the App user.
   If none exists, sign in through `/auth`; in repository E2E tests, use the
   shared authenticated-browser helper. Do not open the Apps page yet. Attach
   App-host response capture first. Stop the App and confirm the JSON state.
   Then open `/projects/<project-id>/apps`. The Apps page calls the SDK access
   session endpoint, assigns its signed URL to the iframe, and exchanges it for
   an App-host cookie in that browser profile. Target the cross-origin frame
   through frame-aware browser automation. Confirm the page shows the live
   preview and active version in both light and dark mode. For App document
   responses, allow `202` while starting and require the final response to be
   `200`; reject every `5xx`. Assert the iframe body marker. Inspect every
   captured lifecycle body for the forbidden strings from step 7. Do not accept
   a screenshot without DOM and network assertions.

## Diagnose

Use the immutable deployment id from `kortix apps show <slug> --json`:

```bash
kortix apps logs <slug> <deployment-id> --limit 200
```

A server App's logs come from its runtime (`app`, `appd`, `caddy`). A static
App has no runtime: the same command prints its deployment events, one per
line, for example `<time> kortix  [site_published] Published 12 files (12 new,
0 unchanged)`. A failed static deploy names its cause in the deployment's
`error_code` (`invalid_site` for a missing root, an empty root, too many files,
or a file that is too large). An `environment_ignored` event means `env` or
`secrets` were set: a static App runs no server and never reads them.

The stable App URL displays branded queued, validating, building, provisioning,
checking, starting, failed, cancelled, and budget pages while no active version
can serve traffic. Browser lifecycle pages refresh automatically. Machine
clients receive typed JSON and `Retry-After` for transient states. A stopped
healthy App does not expose `app_stopped`, `App not found`, or a temporary
unavailable state.

If a source build fails, inspect the deployment error and build events. Do not
hide a server-build failure by claiming the source type passed. You can deploy a
verified local build as static for immediate delivery, then fix and retest the
source-build path separately.

`--wait-seconds` bounds deployment polling after a deployment id exists. It does
not currently bound context resolution, App creation, packing, upload, or the
deployment-create request. If a command exceeds this duration without printing
a deployment id, record the last visible phase and inspect `kortix apps ls`.
Do not attribute that state to provider throttling without a deployment record
and provider event. Keep blocking deployment as the default; use `--no-wait`
only when another process owns status tracking.

## Lifecycle

```bash
kortix apps start <slug>
kortix apps stop <slug>
kortix apps rollback <slug> <deployment-id>
kortix apps delete <slug> --yes
```

A static App has no runtime. `start` and `stop` answer
`409 static_app_no_runtime`, `kortix apps ls` prints `static` as its state, and
it serves while it has an active deployment. Delete it to take it offline. Run
mode, machine, and budget do not apply to it.

A server App runs in one of two modes. Choose the mode on the first deploy:

- **On demand** (`--on-demand`): stops after the idle timeout (default 300
  seconds) and wakes on the next authorized request. That request waits for
  the cold start. Use it for every App that only answers requests.
- **Always on** (the default for a new App): runs 24/7, and keep-alive restarts
  it within 5 minutes if it stops. Use it only for an App that holds
  websockets open or runs its own background loop. Scheduled jobs and queues of
  an App with a Kortix Backend belong in the backend.

Both modes stop at the App's monthly compute budget, and when the account can
no longer pay. The URL then shows the budget or paused page until the next
month or until the user raises the budget. A new always-on App with no
`--budget` gets its 24/7 estimate (`estimated_monthly_usd`) rounded up to a whole
dollar: 74 USD for the default machine of about 73 USD a month. An on-demand App
gets 5 USD. The CLI prints a line such as `Runs 24/7 on 1 vCPU / 2 GB: about
$73/month (budget $74)`; tell the user that cost. A budget you pass always wins
and never changes by itself. To spend less, use `--on-demand` or a smaller
machine (`--memory-gb 1` is about 59 USD a month).

To set an explicit budget on the first deploy:

```bash
kortix apps deploy . --slug api --type dockerfile --always-on --budget 80 \
  --command '["node","server.js"]' --port 3000
```

Change either later without a redeploy:
`kortix apps set <slug> --on-demand|--always-on` or
`kortix apps set <slug> --budget <usd>`. Keep-alive applies the change within 5
minutes. `always_on` and `monthly_budget_usd` in `kortix.yaml` do the same on
the next `kortix apps deploy --manifest-app <name>`. `deploy`, `create`, and
`set` print an `app_budget_below_always_on` warning on stderr when an
always-on App's budget is below its estimate. Tell the user. Never leave the
warning unreported.

On Daytona and E2B (self-host), an always-on App can be unreachable for up to 5
minutes when the provider stops its VM. On Kortix Cloud the VM is persistent.

`stop` suspends a server App's compute immediately, and keep-alive leaves it
stopped. The next authorized request, or `kortix apps start`, wakes it.

An App keeps its active deployment and the 5 newest other ready ones for
rollback. Kortix retires older ones after each deploy and frees their files,
images, and build logs. Rollback accepts only a ready deployment. A static
rollback switches traffic at once. A server rollback starts the target runtime
first. Delete is destructive and removes the stable identity and its runtimes.

When a Kortix release changes the App supervisor image, Kortix rebuilds a
server App's runtime from the same artifact in the background: on its next
cold start (on demand), or in a keep-alive pass (always on). Traffic stays on
the active deployment until the replacement passes readiness. A release that
changes only the API rebuilds nothing.
