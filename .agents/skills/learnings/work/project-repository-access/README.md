---
title: Project repository access (how the API and the boxes get a project's files, and what it costs)
status: phase 1 on dev (#11492 650ac3e492 partial object store; #11501 aec9dafaf3 named image steps); revamp planned, nothing started
owner: Marko (decisions)
updated: 2026-11-02
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

## The long-term direction (Marko, 2026-11-02)

"Project = volume, git second." A project's files live on a Platinum volume
that every session mounts. Git becomes a sync mechanism, possibly optional:
data is either synced or only available over the network (S3-backed). This
would remove items 1, 3 and most of 2 by construction. The partial store
remains the fallback for git-only hosts and for history features. Related:
`work/platinum-machines-apps/`, and the Drive one-tree work (Platinum volumes
per project).

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
4. The volume-first design is a separate decision for Marko; record it in
   `decisions.md` here.
