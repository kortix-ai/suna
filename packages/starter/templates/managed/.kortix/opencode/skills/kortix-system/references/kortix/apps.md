# Kortix Apps

Kortix Apps deploy static sites and HTTP applications from a project. Each App
has one stable URL. Each deployment is immutable. The active deployment pointer
changes only after the new runtime passes readiness.

Apps is experimental and off by default. Enable **Apps** for the selected
project under Project Settings → Experimental. The API returns `404`, the
public URL does not resolve, and the CLI and web surfaces stay hidden while the
feature is disabled.

## Select a workload

| Source | Use when | Required inputs |
| --- | --- | --- |
| `static` | The directory already contains HTML, CSS, JavaScript, and assets. | Directory. Optional `root`, `spa`, `readiness_path`. |
| `bundle` | A JavaScript project builds static output. | Directory. Optional install/build commands and output directory. |
| `dockerfile` | The application runs an HTTP server or needs a custom build. | Build context, Dockerfile, command argv, target port. |
| `oci_image` | A public image already contains the application. | Immutable image reference, command argv, target port. |

Auto-detection selects `dockerfile` when `Dockerfile` exists. It selects
`bundle` when `package.json` exists. It selects `static` otherwise. Pass
`--type` to override detection.

## First deployment

From a linked project:

```sh
kortix apps deploy . --slug storefront --name Storefront
```

The command performs these operations:

1. Creates the App if `--app` does not name an existing App.
2. Builds a deterministic `.tar.gz` for directory sources.
3. Registers an immutable artifact and uploads it through a signed URL.
4. Queues an immutable deployment.
5. Waits until the runtime passes readiness.
6. Prints the stable App URL.

Use `--no-wait` only when another process will poll deployment state. The
default wait limit is 1,200 seconds. Change it with `--wait-seconds`.

## Repeatable v2 manifest

The `apps:` map is available only in `kortix_version: 2` YAML manifests.
It contains deployment defaults. It does not auto-deploy on merge.

```yaml
apps:
  storefront:
    path: web
    type: bundle
    install_command: corepack enable && pnpm install --frozen-lockfile
    build_command: pnpm build
    output_dir: dist
    spa: true
    readiness_path: /
    idle_timeout_seconds: 300
    monthly_budget_usd: 5
    resources:
      cpu: 1
      memory_gb: 2
      disk_gb: 10
    env:
      NODE_ENVIRONMENT: production
    secrets:
      DATABASE_URL: database-primary
```

Deploy it:

```sh
kortix apps deploy --manifest-app storefront
```

When the manifest declares exactly one App, bare `kortix apps deploy` selects
it. CLI flags override manifest fields.

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
| `spa` | Serve `index.html` when a static path does not exist. |
| `readiness_path` | HTTP path polled before activation. Default `/`. |
| `idle_timeout_seconds` | Stop after no traffic. Minimum `120`; default `300`. |
| `monthly_budget_usd` | Per-App compute safety limit. Default `5`. |
| `resources` | `cpu`, `memory_gb`, and `disk_gb`. Defaults `1`, `2`, and `10`. |
| `env` | Non-secret runtime key/value pairs. |
| `secrets` | Runtime environment key to project secret **identifier** mapping. |

## Secrets and environment

Never place a secret value under `apps.<name>.env`. Use a project secret and map
its identifier:

```yaml
apps:
  api:
    secrets:
      STRIPE_API_KEY: stripe-production
```

The deployment record stores `STRIPE_API_KEY -> stripe-production`. The API
decrypts the current secret only when it creates the runtime. The value does
not enter the archive, build context, image, deployment record, CLI output, or
App logs.

The destination key cannot be a control key such as `PORT`, `PATH`,
`KORTIX_*`, or `OPENCODE_*`. A missing identifier fails deployment with
`invalid_environment`. Broker-only and connector-only secrets cannot be
delivered as App environment values.

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

## Runtime and network

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

## Cold start and stop

An idle stop preserves the runtime. The next request starts the sandbox, waits
for readiness, and then proxies the request. Concurrent wake requests share one
database lease.

`kortix apps stop <app>` changes `desired_state` to `stopped`, stops compute,
and makes public requests return `503 app_stopped`. `kortix apps start <app>`
starts the active runtime immediately and permits future cold wake.

Every request extends the activity lease and idle deadline. Streaming responses
renew the lease until the response ends. WebSocket connections renew it while
the socket remains open.

## Versions and rollback

```sh
kortix apps show storefront
kortix apps rollback storefront <deployment-id>
```

Rollback accepts only a `ready` deployment. Kortix starts and checks the target
runtime first. It then changes the active pointer and stops the previous
runtime. A target start failure leaves the previous deployment active.

## Logs and diagnosis

```sh
kortix apps logs storefront
kortix apps logs storefront <deployment-id> --after 100 --limit 500
```

Deployment events explain validation, build, provisioning, readiness, retries,
activation, and rollback. Runtime logs contain separate `app`, `appd`, and
`caddy` sources. Secret values are not included by the control plane. User code
can still print values it receives; treat application logs as sensitive.

Common failures:

| Code or symptom | Action |
| --- | --- |
| `invalid_spec` | Check relative paths, command argv, target port, and readiness path. |
| `invalid_environment` | Check destination keys and project secret identifiers. |
| `digest_mismatch` / `size_mismatch` | Re-upload the archive. Do not reuse corrupted bytes. |
| `provider_disabled` | Omit `--provider` or select an enabled provider. |
| Readiness timeout | Make the process bind the declared port and return success at `readiness_path`. |
| `402 app_budget_exceeded` | Increase the App budget or wait for the next monthly period. |
| `503 app_stopped` | Run `kortix apps start <app>`. |

## Current boundaries

The first release supports one public HTTP port and one runtime per deployment.
It does not support replicas, autoscaling, regions, UDP, persistent volumes,
private registry credentials, custom domains, or background-only processes.
The hosting provider is an infrastructure policy. Do not encode provider logic
in application code or the manifest.
