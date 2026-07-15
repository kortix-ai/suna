# Runbook: Self-hosting Kortix

**Kortix self-host is VPS-first.** The supported way to run it is on your own
VPS or server with a persistent domain pointed at it — that combination is
what makes reachability, TLS, and agent sandboxes work correctly and durably.
Running it on a laptop is a convenience for evaluating the product, not a
deployment target: laptop mode needs a Cloudflare tunnel (or nothing at all)
to get any external reachability, that URL is ephemeral or missing entirely,
and browsers enforce connection limits against plain-HTTP `localhost` that a
real deployment won't hit. If you're deciding where to run this for real,
provision a VPS and point a domain at it.

Kortix self-host is **one generic Docker-native system**: `kortix self-host`
generates a `docker-compose.yml` + `.env` (+ a `Caddyfile` and `updater.sh` when
a domain is configured) into `~/.config/kortix/self-host/<instance>/` and runs
`docker compose up`. The same artifact happens to also run on a laptop, any
VPS, or a cloud VM (EC2, Droplet, etc.) — there is no separate "target" to
pick, no AWS profile, no Terraform, no TUF/signing, no SSM. A public domain is
just an env var (`KORTIX_DOMAIN`) the same stack reacts to, not a different
deployment mechanism.

The stack: Caddy (reverse proxy + ACME TLS, only present when a domain is
configured) → `kortix-api`, `llm-gateway`, `frontend`, plus the official
Supabase Docker distribution (Kong, Postgres, Auth, Storage, Realtime, etc.),
plus an in-compose `kortix-updater` service that keeps the stack converged to
the configured image channel. Agent sessions still run on Daytona (or another
configured sandbox provider) — sandboxes are managed compute, not part of this
box.

> Superseded material: this runbook replaces `docs/runbooks/enterprise-vpc-deployment.md`
> (the old signed-TUF-channel, Terraform, AWS-EC2/aws-vpc-target design). See
> `docs/specs/2026-07-14-enterprise-appliance.md`,
> `docs/specs/2026-07-14-enterprise-ecs-simplification.md`, and
> `docs/specs/2026-07-13-enterprise-vpc-single-tenant-deployment.md` for that
> design history — all now superseded by the generic self-host system
> described here.

## Prerequisites

- **A VPS or server you control (recommended), or a laptop for evaluation
  only** — Linux (any VPS, EC2, bare metal) or macOS/Linux with Docker Desktop
  or Docker Engine.
- Docker Engine + the Compose plugin (`docker compose version`). The bootstrap
  script below installs these for you on a fresh Linux box.
- **Required for production:** a domain you control, with its DNS A/AAAA
  record (and the API subdomain's) pointed at the box's public IP. This is
  what turns on a public HTTPS URL instead of loopback-only ports, and it's
  the reachability mode agent sandboxes need to work reliably. Ports **80**
  and **443** must be reachable from the internet for ACME HTTP-01 once a
  domain is set.
- **Required for agent sessions to actually run:** a [Daytona](https://app.daytona.io)
  API key (the sandbox provider) and managed-git access (a GitHub PAT or GitHub
  App) so the platform can create project repos. Both can be set after first
  boot with `kortix self-host configure`.
- **Not required to get started:** SMTP. A fresh install auto-confirms email
  signups and leads with password auth, so the first account works with zero
  email configuration. Configure SMTP later to enable magic-link sign-in.

## Reachability (required for agent sessions) — VPS-first

Agent sessions run inside a **cloud** Daytona sandbox — a VM outside your
network — that calls back to this instance's API over the public internet via
`KORTIX_URL`. That means `KORTIX_URL` can never be a loopback/internal
address: a sandbox trying to reach `http://localhost:...` or an internal
Docker hostname like `http://kortix-api:8008` will simply never connect, and
agent sessions fail with a fast, explicit error (or, before this URL was
validated, a confusing hang).

`kortix self-host init`/`configure` ask interactively how this instance is
reachable from the internet, and default to the domain path; non-interactively,
pick one of:

1. **Public domain** (server/VPS/EC2 with DNS) — `--domain kortix.example.com`.
   **The recommended, production path**: turns on the bundled Caddy reverse
   proxy + ACME TLS, and `KORTIX_URL` becomes `https://api.<domain>`. This is
   the only mode with a stable URL and no laptop/browser caveats — deploy on a
   VPS with a domain for anything beyond kicking the tyres.
2. **Cloudflare tunnel** (laptop — no public IP/DNS) — `--tunnel cloudflare`.
   **Evaluation on a laptop only — not recommended for production.** A
   `cloudflared` Compose service exposes the API to the internet with zero
   DNS/firewall setup, and the CLI wires `KORTIX_URL` to the tunnel's public
   URL automatically. By default that URL is **ephemeral** (a fresh one on
   every restart) and browsers enforce connection limits against plain-HTTP
   `localhost` that a real deployment won't hit. See below.
3. **Local only** (neither flag) — loopback URLs only, the historical default.
   **Development only.** Agent sessions and any other external caller
   (webhooks, Slack/Teams OAuth, the git-proxy clone URL) **will not work**.
   Browser-local flows (e.g. creating a GitHub App) still do, since the
   browser runs on the same machine. `start` prints a warning every time this
   mode is active.

Self-host is designed VPS-first: for reliable production use, deploy on a VPS
with a domain (mode 1). Modes 2 and 3 exist for evaluation/development and
print a reminder of that every time they're selected or active.

Switch modes any time with `kortix self-host configure` (interactive) or the
same flags on `init`/`update`. Re-running with neither flag never resets an
already-configured mode.

### Cloudflare tunnel mechanics (mode 2, evaluation only)

`--tunnel cloudflare` adds a `cloudflared` service to the Compose stack that
tunnels straight to `kortix-api` (Caddy is never present in this mode — there
is no domain). By default this is a **zero-config quick tunnel**
(`cloudflared tunnel --url ...`, no Cloudflare account needed): a fresh
`https://<random>.trycloudflare.com` URL is minted every time the
`cloudflared` container starts.

Because that URL is **ephemeral**, `kortix self-host start`/`update` always:

1. Bring the stack (including `cloudflared`) up.
2. Poll the `cloudflared` container's logs for the URL it just printed
   (up to 30s).
3. Write it into `.env` as `KORTIX_URL` and recreate `kortix-api` so the new
   value actually takes effect.

If `cloudflared` was already running (a plain re-`start` with nothing
stopped), it keeps its existing tunnel/URL and this is a no-op. A full
`stop`/`start` (or `down`/`start`) always gets a **new** URL — that's expected
and handled automatically; there is nothing to reconcile by hand.

For a **stable** URL instead — recommended once you're past kicking the
tyres — create a named tunnel in the
[Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/), bind a
hostname to it, and set:

```sh
kortix self-host env set CLOUDFLARE_TUNNEL_TOKEN=... CLOUDFLARE_TUNNEL_HOSTNAME=kortix-tunnel.example.com
kortix self-host start
```

With both set, `cloudflared` authenticates to that specific tunnel
(`cloudflared tunnel run --token ...`) instead of opening a quick tunnel, and
`KORTIX_URL` is derived directly from the hostname — no log-scraping, and it
never changes across restarts.

## Quickstart

**VPS-first: provision a VPS → point DNS at it → `init --domain` → `start`.**
The laptop/tunnel path further down is for evaluating the product only — not
for production use.

### VPS / EC2 / any bare Linux box (recommended)

1. **Provision a VPS or server** (any provider — a small box is enough to
   start: 2 vCPU / 4GB RAM is a reasonable floor).
2. **Point DNS at it** — create an A/AAAA record for your domain (and the API
   subdomain, `api.<domain>` by default) pointing at the box's public IP.
   Ports **80** and **443** must be reachable from the internet for ACME
   HTTP-01 once you set the domain.
3. **Run the bootstrap script**, which installs Docker, installs the `kortix`
   CLI, runs `kortix self-host init --domain <your-domain>`, and starts the
   stack:

```sh
curl -fsSL https://raw.githubusercontent.com/kortix-ai/suna/main/scripts/kortix-selfhost-up.sh \
  | bash -s -- --domain kortix.example.com --email ops@example.com
```

or, if you already cloned the repo:

```sh
bash scripts/kortix-selfhost-up.sh --domain kortix.example.com --email ops@example.com
```

This installs Docker if missing, installs the `kortix` CLI, runs
`kortix self-host init`, points the stack at your domain (turning on the
bundled Caddy reverse proxy with ACME HTTP-01 TLS on 80/443), and runs
`kortix self-host start`. See `scripts/kortix-selfhost-up.sh --help` for every
flag (channel, auto-update policy, instance name, Daytona key). Re-running the
script is safe — every step it drives (`init`, `env set`, `start`) is
idempotent.

Or drive it directly with the CLI, without the bootstrap script (e.g. Docker
is already installed):

```sh
curl -fsSL https://kortix.com/install | bash
kortix self-host init --domain kortix.example.com
kortix self-host start
```

After first boot, configure the sandbox provider and managed git:

```sh
kortix self-host configure       # interactive wizard: Daytona key, GitHub, Pipedream
# or non-interactively:
kortix self-host env set DAYTONA_API_KEY=... MANAGED_GIT_GITHUB_TOKEN=... MANAGED_GIT_GITHUB_OWNER=...
kortix self-host start           # re-applies env + restarts affected services
```

### Evaluating on a laptop (not for production)

This path is for kicking the tyres on your own machine — it is **not**
recommended for real use. See Reachability above for the specific caveats
(ephemeral tunnel URL, browser connection limits on plain-HTTP `localhost`,
and no external reachability at all without the tunnel).

```sh
curl -fsSL https://kortix.com/install | bash
kortix self-host init --tunnel cloudflare
kortix self-host start
```

Supabase, the API, the gateway, and the frontend come up on loopback ports
(default dashboard: `http://localhost:13737`) — the bundled `cloudflared`
quick tunnel is what makes agent sessions work at all with no domain/DNS
(see Reachability above). `start` prints the exact URLs, the tunnel's public
URL, and warns if the sandbox provider or managed git aren't configured yet.
Omit `--tunnel cloudflare` to stay fully local-only (no agent sessions; see
mode 3 above). When you're ready for real use, switch to a VPS with a domain
(see above) — `kortix self-host configure` or `init --domain <domain>` any
time, on the same box or a new one.

## The `kortix self-host` command surface

| Command | Effect |
| --- | --- |
| `kortix self-host init` | Create or refresh this instance's Compose + `.env`. Non-mutating to a running stack. |
| `kortix self-host configure` | Interactive wizard for integrations (Daytona, GitHub, Pipedream) and update policy. |
| `kortix self-host start` | Pull images and start (or re-converge) the stack. Creates config first if needed. |
| `kortix self-host update` / `reconcile` | Pull the configured channel's newest images now, migrate, and roll the stack forward. Exactly what the in-compose auto-updater does on its own schedule, run once immediately. |
| `kortix self-host rollback --release <v>` | Roll back to an explicit older version (same mechanics as `update`, pinned). |
| `kortix self-host version` | Show the running version, the configured channel, and whether a newer release is available. |
| `kortix self-host stop` / `restart` | Stop / restart the stack. |
| `kortix self-host status` | Container status (`docker compose ps`). |
| `kortix self-host doctor` | Validate local Docker tooling and the rendered Compose config. Non-mutating. |
| `kortix self-host logs [service]` | Tail Compose logs. |
| `kortix self-host open` | Open the dashboard in a browser. |
| `kortix self-host env ls` / `env set KEY=VALUE …` | Show / update persistent env values (secrets masked on `ls`). |

Common flags: `--instance <name>` (default `default` — run multiple isolated
stacks on one box), `--tag <version>` / `--release <version>` (pin an explicit
image tag), `--channel stable|latest`, `--auto-update on|off`,
`--update-interval <seconds>`, `--domain <domain>` / `--tunnel cloudflare`
(reachability — see above), `--json`, `--yes`.

Full reference: [`/docs/reference/cli#self-host`](../../apps/web/content/docs/reference/cli.mdx).

## The auto-updater + channels

Every instance always has a `kortix-updater` service in its Compose file (an
`image: docker:cli` container with the Docker socket mounted). On an interval
(default: daily — `KORTIX_UPDATE_INTERVAL`, 86400s) it:

1. Pulls this stack's configured image tags.
2. Fingerprints the resulting image IDs. If nothing changed, it no-ops.
3. If something changed, runs the `kortix-migrate` one-shot to apply any new
   database migrations, then rolls the stack forward (`docker compose up -d --wait`).
4. Writes a breadcrumb (`deployed-version.json`) recording what it applied.

A `flock` around each cycle means an overlapping run always skips rather than
racing a previous one. `KORTIX_AUTO_UPDATE=false` makes every cycle a no-op
without removing the service.

Two channels, both moving Docker tags on `kortix/kortix-api`,
`kortix/kortix-frontend`, and `kortix/kortix-gateway`:

- **`stable`** (default) — recommended for production use.
- **`latest`** — bleeding-edge, tracks the newest published build.

Change channel or policy any time:

```sh
kortix self-host configure                              # interactive
kortix self-host env set KORTIX_CHANNEL=latest           # or: kortix self-host update --channel latest
kortix self-host env set KORTIX_AUTO_UPDATE=false
kortix self-host env set KORTIX_UPDATE_INTERVAL=3600
```

Or pin an exact version instead of tracking a moving tag:

```sh
kortix self-host update --tag 0.9.84
```

`kortix self-host version` shows what's actually running (resolving a moving
tag to the concrete version it currently points to, via Docker Hub) and
whether a newer release is available.

> **Release-flow contract this depends on:** the self-host default channel is
> `stable`, meaning the Kortix release pipeline (`deploy-prod.yml` /
> `Promote` → GitHub Release) must publish/repoint a moving `:stable` tag on
> all three app images (`kortix-api`, `kortix-frontend`, `kortix-gateway`) on
> every production release, the same way it already retags `:latest` and the
> exact `:X.Y.Z`. **As of this writing the release workflow retags `:latest`
> and `:X.Y.Z` only — it does not yet publish `:stable`.** Until that's added,
> self-host installs tracking the (default) `stable` channel will not see new
> versions from the auto-updater; use `--channel latest` or pin `--tag
> <version>` in the meantime, and treat wiring up `:stable` publishing as a
> release-pipeline follow-up, not a self-host CLI change.

## Configuring SMTP, Daytona, and other integrations later

Everything is `kortix self-host env set KEY=VALUE …` followed by
`kortix self-host start` (or the interactive `kortix self-host configure`),
whether at first boot or months later:

```sh
# Sandbox runtime (required for agent sessions)
kortix self-host env set DAYTONA_API_KEY=... DAYTONA_SERVER_URL=https://app.daytona.io/api DAYTONA_TARGET=us

# Managed git (required to create projects) — PAT or GitHub App
kortix self-host env set MANAGED_GIT_PROVIDER=github MANAGED_GIT_GITHUB_TOKEN=... MANAGED_GIT_GITHUB_OWNER=your-org

# SMTP (optional — enables magic-link / email verification instead of the
# password-only, auto-confirmed default)
kortix self-host env set SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... \
  SMTP_ADMIN_EMAIL=admin@example.com SMTP_SENDER_NAME=Kortix
kortix self-host env set ENABLE_EMAIL_AUTOCONFIRM=false KORTIX_PUBLIC_AUTH_METHODS=password,magic

# Pipedream connectors (optional)
kortix self-host env set INTEGRATION_AUTH_PROVIDER=pipedream PIPEDREAM_CLIENT_ID=... \
  PIPEDREAM_CLIENT_SECRET=... PIPEDREAM_PROJECT_ID=...
```

`kortix self-host env ls` lists every key (secrets masked); `kortix self-host
doctor` validates the rendered Compose config without applying anything.

## Backups

There is no separate backup system — it's plain Docker volumes and bind
mounts under the instance directory
(`~/.config/kortix/self-host/<instance>/`):

- `volumes/db/data` — the Postgres data directory (**the durable state that
  matters**: every table, every row).
- `volumes/storage` — Supabase Storage (uploaded files).
- `.env` — every secret and config value for the instance (JWT signing keys,
  API keys, GitHub/Daytona/SMTP credentials). Back this up separately and
  keep it at least as protected as a password vault.
- Two named Docker volumes, both fully regenerable and low-value to back up:
  `kortix-caddy-data` (cached ACME certificates — a fresh cert is issued
  automatically on next start if lost) and `kortix-updater-state` (just the
  updater's lock file + last-deployed breadcrumb).

**Whole-directory snapshot** (simplest, works everywhere a block/file-level
snapshot is available — EBS snapshot, a VPS provider's volume snapshot,
`rsync`, `tar`):

```sh
kortix self-host stop
tar -C ~/.config/kortix/self-host -czf kortix-self-host-backup.tar.gz <instance>
kortix self-host start
```

**Logical backup** (portable across Postgres versions, no downtime required):

```sh
docker compose --project-name kortix-<instance> \
  --env-file ~/.config/kortix/self-host/<instance>/.env \
  -f ~/.config/kortix/self-host/<instance>/docker-compose.yml \
  exec supabase-db pg_dump -U postgres -d postgres > backup-$(date +%F).sql
```

Restore is the inverse: stop the stack, restore `volumes/db/data` (whole-
directory approach) or `psql < backup.sql` against a fresh instance (logical
approach), then start.

## Troubleshooting

- **`docker compose version` fails / "Cannot connect to the Docker daemon"** —
  Docker isn't installed or the daemon isn't running.
  `scripts/kortix-selfhost-up.sh` installs and starts it; on an existing box,
  `systemctl status docker` (Linux) or open Docker Desktop (laptop).
- **A newly created Linux user can't run `docker` without `sudo`** — group
  membership (`usermod -aG docker $USER`) only takes effect in a *new* login
  session; log out/in or start a new shell.
- **`kortix self-host doctor` reports a Compose config error** — usually a
  bad manual edit via `env set`; run `kortix self-host env ls` to see what's
  actually persisted, fix the offending key, and doctor again.
- **Sessions fail to start / "sandbox runtime not configured"** — `DAYTONA_API_KEY`
  isn't set. `kortix self-host configure` or
  `kortix self-host env set DAYTONA_API_KEY=...` then `kortix self-host start`.
- **Creating a project fails ("provider github not configured")** — managed
  git isn't configured. Same fix, with the `MANAGED_GIT_GITHUB_*` keys above.
- **Agent sessions fail with "Cannot connect to the API" / a `KORTIX_URL`
  error, or hang forever** — this instance's reachability mode is `local`
  (the default absent `--domain`/`--tunnel`), or a Cloudflare quick tunnel's
  URL wasn't captured yet. Run `kortix self-host configure` to set up a
  domain or `--tunnel cloudflare`, or re-run `kortix self-host start` — see
  Reachability above. Check `kortix self-host logs cloudflared` if a tunnel is
  configured but the URL capture keeps timing out (cloudflared may be missing
  its image locally yet, or outbound network access to Cloudflare may be
  blocked).
- **ACME/TLS cert issuance fails** — confirm the domain's (and API domain's)
  DNS A/AAAA record actually resolves to the box's public IP, and that ports
  80/443 are open in any cloud/VPS firewall or security group — HTTP-01
  validation needs both reachable from the internet.
- **After `kortix self-host update`, the app looks unchanged** — check
  `kortix self-host version`; if you're tracking `stable` and the release
  pipeline hasn't published a `:stable` tag for the new version yet, see the
  auto-updater section above. `--channel latest` or an explicit `--tag` always
  reflects what's actually published.
- **Logs** — `kortix self-host logs [service]` (services: `frontend`,
  `kortix-api`, `llm-gateway`, `kortix-updater`, `caddy` when a domain is
  configured, `cloudflared` when tunnel mode is configured, plus the Supabase
  services `supabase-db`, `supabase-kong`, `supabase-auth`, etc.).
