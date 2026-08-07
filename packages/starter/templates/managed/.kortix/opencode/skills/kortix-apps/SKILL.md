---
name: kortix-apps
description: "Deploy and operate provider-neutral Kortix Apps through the pre-authenticated CLI or SDK. Use when the user asks to publish, host, deploy, preview, inspect, wake, suspend, roll back, debug, or remove HTML/CSS/JavaScript, a static SPA, Vite or React source, Next.js, a Dockerfile service, or an OCI image on a stable Kortix URL."
---

# Kortix Apps

Kortix Apps turns one source tree or image into an immutable serverless
deployment with a stable URL. Kortix selects and operates the sandbox provider.

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

Use the narrowest source type that preserves the App behavior:

| Source | Preferred deployment |
| --- | --- |
| HTML, CSS, JavaScript | `--type static` |
| Prebuilt Vite or React `dist/` | deploy `dist/ --type static --spa` |
| Vite or React source | `--type bundle --spa` |
| Next.js static export | set `output: 'export'`, build, then deploy `out/ --type static --spa` |
| Next.js server runtime | Dockerfile, command, and port `3000` |
| Any custom HTTP service | Dockerfile, command, and target port |
| Existing public container image | `--image`, command, and target port |

Prefer a prebuilt static directory for generated artifacts. It removes the
remote package-install phase and gives the lowest deployment latency. Use
`bundle` when the server must produce a reproducible build from source. Use a
Dockerfile when the App needs a server process, native packages, or custom
runtime behavior.

Before building generated output, inspect `package.json` and the lockfile. Run
the declared `build` script with the repository's package manager. Do not assume
`pnpm` when the project uses npm, Yarn, or Bun.

## Deploy

Deploy a new App and block until its stable URL is ready:

```bash
kortix apps deploy ./dist --slug storefront --name Storefront --type static --spa
```

Deploy a source bundle:

```bash
kortix apps deploy . --slug storefront --type bundle --spa
```

Deploy a Dockerfile service:

```bash
kortix apps deploy . --slug api --type dockerfile \
  --command '["node","server.js"]' --port 3000 --readiness-path /health
```

Deploy an OCI image:

```bash
kortix apps deploy --image nginx:1.27-alpine --slug nginx \
  --command '["nginx","-g","daemon off;"]' --port 80
```

The command waits for `ready` for up to 1200 seconds. Use `--no-wait` only when
another process owns status tracking. Provider selection is optional. Omit
`--provider` unless an operator explicitly requests a hosting provider.

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
5. For a service, fetch its readiness endpoint and one real application route.
6. For non-public Apps, fetch the stable URL without credentials and confirm it
   returns `401` before testing authorized access.
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

## Lifecycle

```bash
kortix apps start <slug>
kortix apps stop <slug>
kortix apps rollback <slug> <deployment-id>
kortix apps delete <slug> --yes
```

`stop` suspends compute immediately. The next authorized request wakes the App.
Rollback accepts only a ready immutable deployment. Delete is destructive and
removes the stable identity and its runtimes.

On every cold start, Kortix compares the active deployment's App supervisor
version with the current platform version. Kortix queues at most one immutable
replacement in the background. Traffic stays on the active deployment until
the replacement passes readiness.
