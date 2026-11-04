---
title: Project repository access (how the API and the boxes get a project's files, and what it costs)
status: phase 1 on dev (#11492 650ac3e492 partial object store; #11501 aec9dafaf3 named image steps); target decided (one Platinum volume per project, git secondary); nothing of it built
owner: Marko (decisions)
updated: 2026-11-03
---

# Project repository access

Every project is a git repository. The API reads it (config, agents, the file
browser, history, merges, releases), and every session box checks it out. Both
paths fetched far more than they read, and that cost latency, outages and NAT
traffic. Phase 1 fixed the API side. This topic holds what is left and the
revamp it points to.

## What happened (2026-11-02)

- **The outage.** A prod project held 6,388 MB of git history (1,056 MB at
  the tip, agent-written experiment data). Every API replica ran
  `git clone --bare` (all history, all files) of every project it touched.
  That clone never finished inside 90 s × 3 attempts, so
  `GET /v1/projects/:id/detail` answered `503 request_deadline` after 25 s.
- **Why it could happen anywhere.** The clone repeated on every replica after
  every deploy, and again after every eviction from the 4 GiB per-replica
  cache. Agents commit data into repositories, so any project can grow like
  this.
- **The traffic.** In VPC flow logs for the 24 h to 2026-11-02 16:00Z (prod
  NAT ENIs, log group `/vpc/flowlogs`), GitHub was 577 of 809 GB of prod NAT
  inbound (71.3%). A single GitHub endpoint accounted for 574 GB.

## What phase 1 changed (on dev)

Ledger entry for the outage: [`entries/2026-11-02T175853Z-never-copy-a-whole-git-repository-onto-an-api-replica-fetch.md`](../../entries/2026-11-02T175853Z-never-copy-a-whole-git-repository-onto-an-api-replica-fetch.md).

- **Partial object store (#11492, `apps/api/src/projects/git/object-store.ts`, `mirror.ts`).**
  - The store clones commits only (`--filter=tree:0`).
  - Trees and files arrive by id, in one authenticated, byte-capped request
    per read.
  - `GIT_NO_LAZY_FETCH=1` is set process-wide in `config.ts`, so git never
    downloads anything on its own.
  - A fetch-and-retry net handles git errors that name a missing object.
  - Memos remember "too large": exact per tree id, 6 h per producer.
  - Kill switch: `KORTIX_GIT_OBJECT_STORE=full`.
  - Measured on the 6.4 GB repository on dev: the store is 584 KB, and
    `/detail` returns `200` in 2.4 s cold and 0.08 s warm.
- **Named image steps (#11501).** A session start names each sandbox image
  wait (`boot.image`) from the server through the SDK to the web, mobile, TUI
  and CLI. Past 8 s, it boots the image its project booted last. Ledger entry:
  [`entries/2026-11-02T185702Z-a-session-start-never-waits-silently-on-its-image-every-wait.md`](../../entries/2026-11-02T185702Z-a-session-start-never-waits-silently-on-its-image-every-wait.md).

## What is still wrong, in order of expected value

1. **Box checkouts stream through the API.**
   - Every session with repository access clones the tip through the git
     proxy (`apps/api/src/git-proxy/index.ts`, which streams upload-pack to
     the upstream). For the 6.4 GB repository that is 1,056 MB per session
     boot, through our NAT and our API process.
   - Evidence: one prod receiver (`10.20.159.211`) took 247 GB/day of GitHub
     traffic in 121,519 flows, a different pattern from the API replicas.
     It is not yet mapped to a service; see "How to measure".
   - Direction: the box reads its files from the project snapshot
     (`git-proxy/project-snapshot-build.ts` already builds a blobless `.git`
     plus a blob pack in S3), or from the project volume (below). Clones then
     stop passing through the API.
2. **Every refresh lists every branch.**
   - The 60 s whole-store refresh runs `git fetch --prune origin` over
     `+refs/heads/*`, and projects keep one branch per session.
   - A comment in `mirror.ts` (`fetchBranchTip`) records 20,872 refs and
     1.1–1.5 s per listing on one project.
   - Direction: track the default branch, plus the branches a read names, plus
     a bounded recent set. Fetch other session branches by name on demand.
3. **Every replica builds its own store.**
   - After each deploy, each replica pays the cold reads. On dev the same
     `/detail` took 2.4 s on one replica and 4.2 s on another.
   - Direction: a config snapshot per (project, base-tip commit), written once
     when the tip moves. The trigger points already exist in
     `config-releases/publish.ts` and `base-tip.ts`. `/detail`, the per-prompt
     permission read, session create and the sweeps read the snapshot, with
     no git on the hot path. GitHub requests then scale with tip moves, not
     with replicas.
4. **`/detail` returns every file path.** That is 5,429 paths (63 KB) for this
   repository; a 1M-file monorepo would be about 100 MB. Cap the list or page
   it, as `listRepoDirectory` already does.
5. **Smaller costs.**
   - Folder listings show no size for files the store has not fetched, and no
     git protocol gives a size without the file. Showing them needs a host
     API (GitHub trees) or a stored file index.
   - Content search covers at most 64 MB of files per commit.
   - A first file read pays about 0.4 s per round trip.

## Prod NAT inbound, 24 h to 2026-11-02 16:00Z (809 GB)

| Source | GB/day | Share | Status |
|---|---|---|---|
| GitHub | 576.7 | 71.3% | API replica clones: fixed by #11492, reaches prod with the next Promote. Box checkouts through the git proxy: item 1 above. |
| Platinum sandbox ingress | 130.2 | 16.1% | Box responses proxied by the API. `[proxy-bytes]` (`sandbox-proxy/proxy-bytes.ts`) logs bytes per route class per replica per minute; read a day of it before moving any route off the proxy. Design notes below. |
| Supabase Postgres (direct host, IPv4 add-on) | 60.1 | 7.4% | Admission polling loop and the orphan-box full scan fixed (`nat-egress` branch). Private connectivity is an open decision, below. |
| Cloudflare (Platinum control plane) | ~20 | ~2.5% | Not addressed. |
| CloudFront, London edges | 19.4 | 2.4% | Not attributed. Needs an AWS MFA session. |
| S3 + ECR | ~1.1 | 0.1% | S3 gateway endpoint added to the network module (`nat-egress` branch). |

**Database private connectivity: open decision.** NAT processing costs $0.05/GB in eu-west-2, so this line costs about $90/month.
- *IPv6 with an egress-only internet gateway* costs nothing per GB. Supabase serves the AAAA record only after the IPv4 add-on is turned off, which drops connections for under a minute and breaks every IPv4-only client of the direct host. GitHub-hosted runners that run migrations are IPv4-only and would need the session pooler.
- *Supabase PrivateLink* (VPC Lattice resource endpoint, $0.01/GB plus about $16/month) keeps IPv4 and takes the database off the public internet. It is beta and needs the Team plan or higher.

**Platinum direct access: design notes, nothing built.** Platinum's edge already accepts a per-port HMAC token (`POST /v1/sandboxes/:id/expose`, `?t=`). Moving reads direct needs:
- daemon CORS and OPTIONS handling;
- a read-only user context that the daemon enforces;
- an SDK route that tries the edge and falls back to `/v1/p`;
- a client heartbeat to the API, because the proxy is what records `lastUsedAt`.

Writes, app previews, self-host and old mobile builds stay on the proxy. The edge hostnames match the pattern that a consumer security filter blocked for `*.kortix.cloud`, so the fallback is mandatory.

## Target architecture: one Platinum volume per project (decided direction, Marko, 2026-11-02)

The canonical home of a project is **one Platinum volume**, not a git
repository. Everything above is a repair of the git-first model; this is where
the design goes.

Marko's words, 2026-11-02:
- "Kortix project should just be a volume, and repo is secondary. Volume
  first, git second (as a sync mechanism or if even at all)."
- "Long term [we] want to not give a fuck about a git repo & its size, have it
  as a second tier sync potentially even if its huge? Or not have git at all &
  rely on Volumes entirely – with clear distinguishments what is synced & what
  is just network based available so u can have it as big data storage, s3
  backed. The whole concept of 1 Project = 1 PT VOLUME."
- "Imo even this like sparse git checkout is temporary, we need to figure out a
  way to make PT Volume primary, even perhaps with a git-inside, git support
  api inside & then u can configure a general sync towards an external repo on
  something like GH but all canonical is PT Volume."

What that means for the design:

1. **Canonical store.** One Platinum volume per project holds the project's
   files: config, agents, skills, data. Every session box mounts it. Nothing
   clones the project to start a session.
2. **Git inside the volume.** The volume carries the history (a repository
   inside it), and the platform serves a git API on top of it: log, diff,
   branches, change requests. Git is a feature of the volume, not the source
   of truth.
3. **External repositories are a sync target.**
   - Linking GitHub or another host configures a general sync between the
     volume and that repository. The repository is a mirror; the volume is
     canonical.
   - Size limits and policy can be enforced at the sync and the Kortix git
     proxy. A host such as GitHub accepts any push, so enforcing at the host
     is not possible.
4. **Two tiers of data.**
   - *Synced*: files every box has locally, such as config and code.
   - *Network-available*: large data on S3-backed storage, read on demand and
     never copied into every box or into git.
   - The project states which is which, so a 6 GB dataset is storage, not
     repository history.
5. **The API reads the volume, not git.**
   - Project config, the file browser and search read the volume through
     Platinum.
   - The partial object store (`object-store.ts`) is then the bridge for
     projects still on git-only hosts, and for the migration, not the main
     path.

Consequences:
- Items 1, 3 and most of 2 above disappear by construction: there are no box
  clones through the API and no per-replica stores.
- Item 4 becomes a volume listing with pages.
- Repository size stops being a platform problem.

Open design questions (decide here, in `decisions.md`):
- **Git inside:** a bare repository on the volume with working trees per
  session, or a git server in Platinum.
- **Concurrency:** how two sessions on one volume isolate their edits. Today
  each session has its own branch and checkout.
- **Sync semantics:** one-way or two-way with an external host, and conflict
  handling.
- **Where tier boundaries are declared:** `kortix.yaml`, or per folder.
- **Migration:** moving existing git-first projects, and the order of
  surfaces.
- **Self-host:** what a self-hosted install without Platinum volumes keeps.

Related:
- `work/platinum-machines-apps/` (the sandbox as a Machine);
- the Drive work: one Platinum volume per project for Files (the `drives`
  table, `drives/service.ts`), which is the closest existing piece.

## How to measure

- **Reference repository.** The 6.4 GB public repository from the outage.
  Its URL stays out of tracked files: it is in the private agent memory and
  in the read-only dev test project in the owner's account. To create a local
  test project: insert `kortix.projects` plus `kortix.project_git_connections`
  with `provider='generic'`, `auth_method='none'` and `upstream_url=<public url>`.
  Read-only means sessions cannot push to it.
- **NAT attribution.** This needs an AWS MFA session (`kortix-mfa-required`).
  1. Read `BytesInFromDestination` per NAT gateway (CloudWatch
     `AWS/NATGateway`).
  2. In Logs Insights on `/vpc/flowlogs`, run:
     `filter @logStream in ["<nat-eni>-all", …] and not isIpv4InSubnet(srcAddr,"10.0.0.0/8") and isIpv4InSubnet(dstAddr,"10.0.0.0/8") | stats sum(bytes) by srcAddr`.
  3. Match the sources against `https://api.github.com/meta` (`git`, `web`, `api`).
  4. Map receiving private IPs to ECS services via CloudTrail
     `CreateNetworkInterface`.
- **Tests.** `apps/api/src/projects/git/__tests__/partial-store-fixture.ts`
  gives an upstream that serves partial clones (`uploadpack.allowFilter`,
  `allowAnySHA1InWant`, and a `file://` URL: git ignores `--filter` on a plain
  path).

## Pick-up order

1. Measure item 1 (about 15 min with MFA). If the git proxy carries the
   247 GB/day, start there.
2. Item 2: small and low risk; ship it with any other item.
3. Item 3 before item 1 if cold reads after deploys hurt more than traffic.
4. The target architecture (one Platinum volume per project) is the decided
   direction. Before building items 1–3 at length, check whether the volume
   work makes them unnecessary. Answer the open design questions in
   `decisions.md` first.
