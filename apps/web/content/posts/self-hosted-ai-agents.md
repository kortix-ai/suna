---
title: "Self-hosted open-source AI agents: four checks decide the install"
description: "Self-hosting open-source AI agents comes down to four operational checks: where sessions run, who can sign up, what you back up, and the monthly bill."
date: "2026-10-21"
slug: "/self-hosted-ai-agents"
canonical: "https://kortix.com/blog/self-hosted-ai-agents"
author: "team"
tags: ["Field notes"]
---
Self-hosted AI agents are agents whose control plane you run: the repo, the shared memory, the accounts and the credentials live on a server you own, while each session runs on a cloud computer that calls back to it. Anyone can stand that up in an afternoon, and the model choice rarely decides what breaks later. Four checks do: where sessions run, who can create an account, what you back up, and the monthly cost. Kortix is the open-source AI Operating System: your agents, skills, company memory, and connectors in one git repo you own, with the agents working on real cloud computers.

## Where the pieces run

A self-hosted Kortix instance is the full platform on your server: one Docker Compose stack that the `kortix` CLI installs, configures and updates. `kortix self-host init` writes four files into `~/.config/kortix/self-host/<instance>/`: `docker-compose.yml`, `.env`, a `Caddyfile` and `updater.sh`. One Compose project, `kortix-<instance>`, holds the web front end and `kortix-api` serving `/v1`. Beside them run a standalone `llm-gateway`, a one-shot `kortix-migrate` job and a daily `kortix-updater`. The Supabase distribution sits behind them, pinned by digest, with Caddy in domain mode or `cloudflared` in tunnel mode. `kortix self-host start` runs `docker compose up` on that project.

None of the agent work happens on that server. Every session runs on a Platinum sandbox. `kortix-api` creates it with your `PLATINUM_API_KEY`, and the sandbox calls back to the instance's public API URL. The box is a control plane and a database, and the compute sits elsewhere. The model is not the part you host either, since the gateway calls providers you already hold keys for. What you host is the system around it.

Reachability decides the rest of the install.

| Mode | Public URLs | Sessions run |
|---|---|---|
| domain | site and API on your own domain | yes |
| tunnel | app on localhost, API on a tunnel URL | yes |
| local | none, every port on loopback | no, the sandbox cannot reach the API |

Domain mode is the production setup, where Caddy terminates TLS on 80 and 443 with an ACME certificate. Local mode is the honest answer to whether you can host an AI agent locally. The stack runs. The web app answers on `http://localhost:13737`, but no session starts, because a Platinum sandbox cannot reach an API bound to `127.0.0.1`. Tunnel mode is for evaluation on your own machine. The [install script's header](https://raw.githubusercontent.com/kortix-ai/suna/dev/scripts/kortix-selfhost-up.sh) calls a run without `--domain` "for evaluation/testing only, not real use".

Before the first start, point A or AAAA records for `<domain>` and `api.<domain>` at the server. Add a `*.p.<domain>` wildcard for previews, and open ports 80 and 443. Without the wildcard, previews fall back to a path proxy that breaks root-absolute links, and the doctor fails the install.

## Sign-up stays open until you close it

One sentence in the self-hosting docs decides whether an install is safe. Until you set `EMAIL_URL` or `DISABLE_SIGNUP=true`, "anyone who reaches the instance can create a confirmed account for any address, the admin address included". A new instance confirms every sign-up without sending mail. A domain-mode install is reachable by design, so an install that only ran the bootstrap had this decided for it.

Closing it takes one command and a restart. Run `kortix self-host env set DISABLE_SIGNUP=true`, then `kortix self-host start`, so the auth service reads the value. If you want invitations and magic-link sign-in instead, set a provider connection string in `EMAIL_URL`. That turns automatic confirmation off and makes an address prove itself. Sign up as the platform admin first either way: while sign-up is open, whoever claims an allowlisted address first becomes the admin.

## Backups and updates are the part you own

A backup is three paths and one key. The instance directory, `~/.config/kortix/self-host/<instance>/`, holds all of it: `.env` carries every secret and signing key, `volumes/db/data` holds Postgres, and `volumes/storage` holds stored files. Stop the stack so the database files are consistent, copy the directory, start again:

```bash
kortix self-host stop
sudo tar -czf kortix-backup.tgz -C ~/.config/kortix/self-host default
kortix self-host start
```

A database dump alone is not the backup, because `API_KEY_SECRET` in `.env` encrypts every stored secret, connector credential and token. Lose it and the platform keeps serving while credentials stop decrypting: project secrets read as Undecryptable, a connector call returns `credential_undecryptable`, and a request that needs a value answers `409 SECRET_UNDECRYPTABLE`.

Updates run themselves. `kortix-updater` runs once a day at 02:00 by default in America/New_York. It tracks the stable channel, the release Kortix promotes after it runs in production. Each run checks free disk space, pulls the tags, migrates and rolls the API, gateway and front end. A failed migration swaps nothing, and the previous version keeps serving. `kortix self-host status` reports the last outcome and the version change. `kortix self-host rollback --release <version>` goes back, and `--tag` pins one version through every daily run.

## The doctor verifies the install

`kortix self-host doctor` runs seven checks and exits 0 when all pass, 1 when one fails.

| Check | Fails when | Fix |
|---|---|---|
| docker | `docker --version` fails | Install Docker |
| docker-compose | the Compose plugin is missing | Install the Compose plugin |
| compose-config | the rendered Compose file is invalid | Set the value the error names |
| instance-dir | the instance directory moved | Run configure, init, start or env set |
| email-url | `EMAIL_URL` is set but unparsable | Correct the value |
| preview-origins | domain mode has no preview base domain | Add the wildcard record, set the domain |
| open-sign-up | sign-up open, email confirmation off | Set `EMAIL_URL` or `DISABLE_SIGNUP=true` |

Two of the seven face outward, and those are the ones installs skip. `preview-origins` fails a domain-mode instance that never added the wildcard, and `open-sign-up` fails any public instance where confirmation is off. The rest is hygiene the default handles: only Caddy publishes public ports, `.env` is written with mode 0600, and connectors refuse private and internal addresses.

## What the month costs

Three bills, and the software is not one of them. The first is the server, which needs a public IP, disk for Postgres, storage and two image versions, and ports 80 and 443 open. The docs publish per-service memory defaults rather than a minimum server size. They come to 2 GB each for `kortix-api` and `llm-gateway`, a memory default of 512 MB for the frontend, and a fixed 1,280 MB for Postgres.

The second is sandbox compute. Platinum charges for the machines your sessions run on, through the key you set at configure time. The default idle stop is 15 minutes after a turn ends. `KORTIX_SANDBOX_AUTOSTOP_MINUTES` is the first thing to tune if that bill surprises you. The third is model tokens, charged by the provider you connected. Each project holds its own key, and no managed-models markup sits in between.

Kortix itself costs nothing here. Self-host is free, and the managed cloud is the same platform on someone else's servers. Free to start, free to self-host, and [the pricing page](https://kortix.com/pricing) carries the managed tiers.

## What open source changes about the install

Open source. Read it, fork it, audit it. The system's definition lives in files you can diff: `kortix.yaml` and the agent files. On your own server those files are the patch path, and the code behind them tells you what the updater rolls at 02:00 and what the doctor checks.

## When not to self-host

Self-hosting costs an afternoon and then a standing commitment. Skip it when one person wants an agent on a laptop for their own files. Local mode runs the stack and starts no sessions. Skip it when the need is chat over documents. A chat interface is far less to own, and [the self-hosted workspace comparison](/blog/best-self-hosted-ai-workspace) covers that field. Skip it when nobody wants to own a server, its patches and its backups, because the managed cloud is the same platform without that work.

The four checks are worth running even if you end up on the cloud. They are questions about the system, and a self-hosted install is the one place you can answer all four from a shell.

[Is Kortix free?](/blog/is-kortix-ai-free) covers the billing side. [The review gate](/blog/open-source-ai-agent-platform) explains what stops agent work before it lands. The [self-hosting docs](https://kortix.com/docs/host) hold every command in full. [Kortix](https://kortix.com) is where to start an instance.

```cta
title: Run it on your own server
body: Free to start, free to self-host.
```
