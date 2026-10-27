# The App model: releases, machines, volumes

## Releases

Every `kortix apps deploy` creates a release: version `vN`, its artifact (files,
a Dockerfile build or an OCI image) and its config (the `kortix.yaml` block,
resolved). A release never changes. `kortix apps releases <app>` lists them and
marks the live one.

- **Rollback** (`kortix apps rollback <app> <vN>`) is a NEW release from vN's
  artifact and config, rolled out like a deploy. Volumes keep their data.
- **Release command** (`deploy.release_command`): runs once per release, after
  the build and before any machine changes, in a temporary machine with the new
  image, the release's env and secrets, and no volume. A non-zero exit fails the
  release: nothing changes, the live release keeps serving. Use it for schema
  migrations of an external database.
- Kortix keeps the 5 newest ready releases besides the live one as rollback
  targets.

## Machines

A server App runs machines. Each machine belongs to one **process group**:

```yaml
processes:
  app: ""                      # "" runs the image's own command
  worker: "node worker.js"     # a shell command
```

- `kortix apps scale count <app> <n> --process <group>` sets the machines per
  group (0–20). Default: 1 per group.
- A machine keeps its id across releases. Each release replaces its box (its
  root disk resets); data that must survive belongs on a volume.
- `vm` sizes machines per group: `vm: [{ cpu: 2, memory_gb: 4 }, { cpu: 1,
  memory_gb: 1, processes: [worker] }]`. A resize is a new release, never an
  image rebuild.
- `kortix apps machines <app>` lists them; `machines start|stop|restart|destroy
  <app> <machine>` acts on one. Destroying a machine keeps its volume, and its
  group runs one machine fewer.
- `kortix apps exec <app> [--machine <id>] -- <command…>` runs one command in a
  running machine (project admins; audited) and returns its output and exit code.

Every machine gets this environment, besides the release's `env` and `secrets`:

| Variable | Value |
| --- | --- |
| `KORTIX_APP_SLUG` | the App's slug |
| `KORTIX_APP_URL` | the App's URL (its `http` service) |
| `KORTIX_SERVICE_URL_<NAME>` | the URL of every other HTTP service (`-` → `_`) |
| `KORTIX_USES_URL_<SLUG>` | the URL of every App this App `uses` (`-` → `_`): a server calls it there |
| `KORTIX_MACHINE_ID` | the machine id (stable across releases) |
| `KORTIX_PROCESS_GROUP` | the machine's group |
| `KORTIX_APP_ID` | the App's id |
| `KORTIX_APP_TOKEN` | the App's bearer for its App events and scheduled runs (SKILL.md, "Start an agent from an App") |
| `KORTIX_APP_EVENTS_URL` | where the App posts App events: `…/v1/projects/<project_id>/apps/<app_id>/events` |
| `KORTIX_AUTH_ISSUER`, `KORTIX_AUTH_AUDIENCE`, `KORTIX_AUTH_JWKS` | verify the App's Kortix sign-in tokens (sign-in.md) |

## Services

A service is a named port of a process group:

```yaml
http_service:                    # the primary service: the App's own host
  internal_port: 3000
  access: app                    # public | app (the App's access policy) | admins
  auto_stop_machines: stop       # off | stop | suspend (suspend stops, like stop, today)
  auto_start_machines: true
  min_machines_running: 0
  processes: [app]
  checks: [{ type: http, path: /health, interval_s: 15, timeout_s: 5, grace_period_s: 10 }]
services:
  - { name: site, internal_port: 3001, access: public }   # on <host>--site
```

- The primary service answers on the App's host; another service on
  `<env>-<slug>-<route key>--<name>` (local: `<route key>--<name>.apps.localhost`).
  `app.services[].url` has each URL.
- `access` gates the service's host. `public`: no gate. `app`: the App's access
  policy. `admins`: the App's policy, then project admins (`project.app.admin`)
  only.
- The proxy spreads requests over the group's running machines. With
  `auto_stop_machines: stop`, an idle machine stops and the next request, a
  trigger that calls the App (`run: { app }`) or a scheduled run starts one (a
  stop keeps the disk and loses memory; `idle_timeout_seconds`, 120–86400,
  default 300, sets when); `min_machines_running` keeps that many up. `always_on: true` is the
  shorthand for `auto_stop_machines: "off"` and one machine always running.
- A group with no service is a worker: it runs and is never idle-stopped.
- Checks run inside the machine. A release is live only when every check of
  every new machine passes.

## Volumes

```yaml
mounts:
  - { source: data, destination: /data, initial_size_gb: 10, snapshot_retention_days: 5 }
```

- A volume is a persistent disk (Platinum). It outlives every release and every
  machine. Each machine of a mounted group has its own volume; a new machine
  takes a free volume of that name first, else gets a new, empty one.
- One machine writes a volume at a time. A release with a mount deploys
  `rolling`: stop the old machine, commit and detach the volume, mount it on
  the new machine. Seconds of downtime; no acknowledged write lost.
- Snapshots: Kortix takes one every day. Daily and manual snapshots are kept
  `snapshot_retention_days` (default 5, at most 60). `volumes snapshot` takes one now; `volumes restore`
  makes a snapshot the volume's contents again (a new version; nothing is
  lost); `volumes fork` makes an instant, unattached copy; `volumes set
  --retention <days>` keeps daily snapshots longer. A snapshot commits the
  mounted volume first, then pins that commit.
- Size: Platinum allots every volume a fixed 100 GB; a volume cannot grow.
  `kortix apps volumes` shows use and size. Keep uploads and documents that
  can outgrow it in object storage.
- Scale: a group with a mount runs one machine (`409 volume_single_machine`).
  Scale it up with `kortix apps set --cpu/--memory-gb`. `scale count
  --new-volumes` gives each new machine its own, empty volume.
- Destroying a volume (or the App) keeps a final snapshot for 7 days, then
  Kortix purges it.
- A mount's `destination` cannot sit under a system directory (`/etc`, `/usr`,
  `/var`, `/kortix`, …): use `/data`, `/convex/data`, `/srv/...`.

## Deploy strategies

| Strategy | What happens | Default when |
| --- | --- | --- |
| `bluegreen` | Every new machine starts and passes its checks, then traffic moves, then the old machines go. No downtime. | no mount |
| `rolling` | One machine at a time; a machine with a volume hands it over (stop, detach, mount). Traffic moves with the first healthy machine. | a mount |
| `immediate` | Every machine is replaced at once; traffic moves without waiting for checks. | — |
| `canary` | One new machine first; when it is healthy, the rest roll. | — |

`bluegreen` and `canary` are refused with a mount (two machines on one volume).
A release that never gets healthy is abandoned: its machines go, traffic stays
on (or returns to) the previous release, and a replaced machine comes back on
its own volume.

## Display

`display` says where Kortix shows the App. It is presentation only: how the
App runs and who may open it do not change.

```yaml
display:
  listed: true          # a card in the Apps grid (default false: Background Apps)
  preview: none         # live (default): the card frames the App; none: an icon card
  parent: backend       # a tab in backend's App detail, not a card of its own
```

- `parent` names another App of the same `kortix.yaml`. A tab whose parent
  does not exist stays a card. The tab label is the App's name without the
  `<parent>-` prefix (`backend-dashboard` → Dashboard).
- An App with `preview: none` opens on its first tab.
- `display` lives in the App's `kortix.yaml` block: a push applies it on
  sync, no deploy needed. `--listed` / `--unlisted` on `deploy` or `set`, and
  Settings → "Show on Apps page", write it to `apps.<slug>.display` first.
  `kortix apps show` prints it on the `shown` row.

## Templates

`kortix apps launch --template <name> [--name <slug>]` writes a ready-made
App's blocks into `kortix.yaml`, writes the files its Apps build from, and
deploys them. Templates are data: pinned images, config and files, nothing the
platform runs specially.

- **Files:** paths from the project root (for example
  `apps/<name>/dashboard/Dockerfile`). A file that already exists is yours:
  `launch` keeps it.
- **Secrets:** right after the named App deploys, `launch` runs a command on
  its machine and writes the last line it prints to a project secret. Every
  launch rewrites it: the value belongs to the App just launched, and one left
  by an earlier App of the same name is stale. The value is never printed.

| Template | What it is | Reference |
| --- | --- | --- |
| `convex` | A self-hosted Convex backend + its dashboard (two images, so two Apps; the dashboard is a Dockerfile App in `apps/<name>/dashboard`, a tab of the backend, admins only, signed in) | convex.md |

Not yet: TCP services (a Postgres or Redis client protocol; `protocol: tcp` is
refused) and private networking between Apps. Until then a database that speaks raw TCP can only be
reached from inside its own machine (`kortix apps exec`).
