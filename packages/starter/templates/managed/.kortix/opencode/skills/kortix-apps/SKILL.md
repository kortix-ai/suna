---
name: kortix-apps
description: "Deploy and operate provider-neutral Kortix Apps through the pre-authenticated CLI or SDK. Use when the user asks to publish, host, deploy, preview, inspect, wake, suspend, roll back, debug, or remove HTML/CSS/JavaScript, a static SPA, Vite or React source, Next.js, a Dockerfile service, or an OCI image on a stable Kortix URL."
---

# Kortix Apps

Kortix Apps turns one source tree or image into an immutable serverless
deployment with a stable URL. Kortix selects and operates the sandbox provider.

## Preflight

1. Run `pwd` and inspect the intended source directory before deploying.
2. Run `kortix projects info --json` to confirm the selected project.
3. If Apps is disabled, ask a project manager to enable the Experimental Apps
   feature. API and CLI execution are project-gated.
4. Do not create an empty App identity first. `kortix apps deploy` creates the
   identity when `--app` is omitted.
5. Never run `kortix apps deploy` from an uninspected workspace root. It can
   publish unrelated files as a static App.

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

## Verify

Do not stop at a `ready` status.

1. Read the App and deployment ledger:

   ```bash
   kortix apps show <slug> --json
   ```

2. Fetch the stable URL. Assert status `200`, the expected body marker, and the
   content type. Fetch at least one CSS or JavaScript asset for static Apps.
3. For an SPA, fetch a client route and confirm it returns the SPA entrypoint.
4. For a service, fetch its readiness endpoint and one real application route.
5. Run `kortix apps stop <slug>`, then request the stable URL. The request must
   resume the runtime and return the App. A stopped runtime is suspended, not
   disabled.
6. Confirm the Apps page shows the live preview and the active version.

## Diagnose

Use the immutable deployment id from `kortix apps show <slug> --json`:

```bash
kortix apps logs <slug> <deployment-id> --limit 200
```

The public URL displays queued, validating, building, provisioning, checking,
failed, and unavailable pages while no active version can serve traffic. Do not
treat `App not found` as a deployment state for an existing App identity.

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

`stop` suspends compute immediately. The next public request wakes the App.
Rollback accepts only a ready immutable deployment. Delete is destructive and
removes the stable identity and its runtimes.
