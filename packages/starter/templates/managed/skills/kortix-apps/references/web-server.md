# Server web Apps

A server App (a Dockerfile or an OCI image) runs in its own machine. It has a
run mode (always on or on demand). Use one only
when the App needs its own server process, native packages, or custom
runtime behavior. Data and server logic for a UI belong in a Convex backend App
(convex.md), not here.

| Source | Deploy |
| --- | --- |
| Next.js server runtime | Dockerfile, command, and port `3000` |
| Any custom HTTP service | Dockerfile, command, and target port |
| Existing public container image | `--image`, command, and target port |

## Deploy

Choose the run mode on the first deploy (Lifecycle, below):

```bash
kortix apps deploy apps/api --slug api --type dockerfile --on-demand \
  --command '["node","server.js"]' --port 3000 --readiness-path /health

kortix apps deploy --image nginx:1.27-alpine --slug nginx \
  --command '["nginx","-g","daemon off;"]' --port 80
```

`dockerfile` and `oci_image` require `--command` and `--port`. A server App
supports one public HTTP port, HTTP streaming, SSE, and WebSockets.

## Lifecycle

```bash
kortix apps start <slug>
kortix apps stop <slug>
kortix apps rollback <slug> <deployment-id>
```

A server App runs in one of two modes. Choose the mode on the first deploy:

- **On demand** (`--on-demand`): stops after the idle timeout (default 300
  seconds) and wakes on the next authorized request. That request waits for
  the cold start. Use it for every App that only answers requests.
- **Always on** (the default for a new App): runs 24/7, and keep-alive
  restarts it within 5 minutes if it stops. Use it only for an App that holds
  websockets open or runs its own background loop. Scheduled jobs and queues
  of an App that uses a Convex backend App belong in the backend App.

Apps have no monthly budget. Both modes stop when the account can no longer
pay (event `app_stopped_unfunded`). The run mode decides what bills:

- **On demand:** billed only while the App is awake.
- **Always on:** the machine bills 24/7, with or without traffic.

The CLI prints a line such as `Runs 24/7 on 1 vCPU / 2 GB`; tell the user the
run mode, never a price. To use less compute, use `--on-demand` or a smaller
machine (`--memory-gb 1`).

```bash
kortix apps deploy apps/api --slug api --type dockerfile --on-demand \
  --command '["node","server.js"]' --port 3000
```

Change the mode later without a redeploy:
`kortix apps set <slug> --on-demand|--always-on`. Keep-alive applies the change within 5 minutes. `always_on` in `kortix.yaml`
does the same on the next
`kortix apps deploy --manifest-app <name>`.

On the legacy Daytona fallback (self-host), an always-on App can be unreachable for up to
5 minutes when the provider stops its VM. On Kortix Cloud the VM is
persistent.

`stop` suspends compute immediately, and keep-alive leaves it stopped. The
next authorized request, or `kortix apps start`, wakes it. A rollback starts
the target runtime first.

When a Kortix release changes the App supervisor image, Kortix rebuilds a
server App's runtime from the same artifact in the background: on its next
cold start (on demand), or in a keep-alive pass (always on). Traffic stays on
the active deployment until the replacement passes readiness. A release that
changes only the API rebuilds nothing.

## Process groups, services, volumes

A server App is a release + machines (apps-model.md). Beyond one process:

- **Process groups:** `processes: { app: "", worker: "node worker.js" }`, one
  machine per group by default; `kortix apps scale count <slug> 3 --process
  worker`. A group with no service is a worker.
- **More services:** `services: [{ name: admin, internal_port: 9000, access:
  admins }]` answers on `<host>--admin`.
- **State:** never on the root disk (each release replaces it). Mount a volume:
  `mounts: [{ source: data, destination: /data }]`. The release then deploys
  `rolling` and keeps the data (apps-model.md, Volumes).
- **Migrations:** `deploy: { release_command: "node migrate.js" }` runs once
  before machines change; a failure leaves the live release serving.
- **Debug:** `kortix apps machines <slug>`, then `kortix apps exec <slug> --
  <command>` (project admins).

## Verify

Run web-static.md, Verify, steps 2 and 5 first (`hosting_type` is `sandbox`
here, and `capabilities` lists `sleep`). Confirm `always_on` is the value you
chose. Then:

1. Fetch its readiness endpoint and one real application route.
2. Run `kortix apps stop <slug> --json`. Confirm `desired_state` is
   `stopped`. Request the stable URL with the existing App-host cookie
   without running `start`. Poll for up to 120 seconds until the final
   response is `200`. A machine response can return `202` with
   `Retry-After: 3` while the provider resumes. A browser navigation receives
   the same `202` with branded HTML and a three-second refresh. The body must
   never expose `app_stopped`, `App not found`, `temporarily unavailable`, or
   `App is temporarily unavailable`.
3. Re-read `kortix apps show <slug> --json`. Confirm the active deployment
   did not change during a normal wake. If it changed, require the new active
   deployment to be `ready`, `actor_type: system`, `source_session_id: null`,
   and to reuse the prior `artifact_id`, `source_kind`, and
   `hosting_provider`. Those fields identify a background runtime refresh.
4. `kortix apps machines <slug>`: every machine `started` on the live release.

## Diagnose

```bash
kortix apps logs <slug> <deployment-id> --limit 200
```

A server App's logs come from its runtime (`app`, `appd`, `caddy`). The
stable App URL displays branded queued, validating, building, provisioning,
checking, starting, failed, and cancelled pages while no active
version can serve traffic. Machine clients receive typed JSON and
`Retry-After` for transient states.

If a source build fails, inspect the deployment error and build events. Do
not hide a server-build failure by claiming the source type passed. You can
deploy a verified local build as static for immediate delivery, then fix and
retest the source-build path separately.

`--wait-seconds` bounds deployment polling after a deployment id exists. It
does not bound context resolution, App creation, packing, upload, or the
deployment-create request. If a command exceeds this duration without
printing a deployment id, record the last visible phase and inspect
`kortix apps ls`.

## An agent calls the App's API

Register the App's API as a project connector whose base URL is the App URL
(kortix-connectors, `<adding-connectors>`), and call it with
`kortix connectors call`. For an App of the same project on `https`, the
connector gateway adds a 60-second App assertion. The App gate verifies it,
resolves it to the session's own token, and applies the App's access policy
to that session. Neither the agent nor the App handles a Kortix credential.
Never paste a personal token into the App instead.
