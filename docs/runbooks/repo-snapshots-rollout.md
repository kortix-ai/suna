# Config Provider v1 — production rollout

Prepared, not performed. Nothing here has been applied to any environment; the
feature is `off` in every environment and stays `off` until someone follows this
document deliberately.

Read `repo-snapshots.md` first — it describes what the feature IS. This is the
order of operations for putting it in front of production traffic, what each
step costs, what proves it worked, and how to undo it.

---

## 0. What must be true before step 1

| Prerequisite | How to check | Who |
| --- | --- | --- |
| A private S3 bucket exists in the API's region, versioning on, public access blocked, SSE enabled | `aws s3api get-bucket-encryption --bucket <bucket>` | infra |
| Its key prefix per environment is decided (`prod/`, `staging/`, `dev/`) | one bucket may be shared; the prefix is the isolation boundary | infra |
| The API task role can `s3:GetObject` and `s3:PutObject` on `<bucket>/<prefix>*` | `repo_snapshot_bucket` in the environment's tfvars; see §2 | infra |
| A GitHub webhook secret exists for push ingestion (optional; reconciliation covers projects without one) | `KORTIX_REPO_SNAPSHOT_WEBHOOK_SECRET` | infra |

**Not required:** static access keys. The API resolves credentials through the
standard AWS chain, which on ECS is the task role. `s3-role-credentials.test.ts`
exercises that path against a loopback stand-in for the container credential
endpoint, including the session token and the credential's own expiry.
`KORTIX_REPO_SNAPSHOT_ACCESS_KEY_ID` / `..._SECRET_ACCESS_KEY` exist for local
MinIO and should stay unset in a deployed environment.

---

## 1. Artifact compatibility

Three artifacts move independently. The order below is the only one that is
safe, and each step is safe to stop at.

| Artifact | Carries | Compatible with |
| --- | --- | --- |
| Database | `kortix.repo_snapshots`, `kortix.repo_snapshot_refs` | every API build, old and new — both tables are new and unread by old code |
| API | publisher, worker, session pin, Git-proxy snapshot routes | any daemon; it only SENDS a descriptor when the mode says so |
| Supervisor daemon (`kortix-sandbox-agent-server`) | the snapshot consumer | any API; it only ACTS on `KORTIX_REPO_SNAPSHOT_URL`, which an older API never sets |

So: **migrate, then deploy the API, then (already) ship the daemon.** A daemon
that predates this feature ignores the descriptor env entirely and falls back to
its existing clone path, which is what `mode=prefer` is designed to tolerate. A
session on such a sandbox is counted as a fallback, not an error.

`mode=required` must NOT be enabled until every sandbox image in rotation
carries a daemon that understands the descriptor, because `required` removes the
Git fallback that an old daemon depends on.

---

## 2. Migrations

Two, both additive:

| Migration | What it does | Cost at prod volume |
| --- | --- | --- |
| `20260912112702711_repo_snapshots.sql` | creates two empty tables + indexes | milliseconds; `lock_timeout = 2s`; nothing existing is touched |
| `20260912164500000_repo_snapshot_ref_alias_consolidation.concurrent.ts` | consolidates legacy `refs/heads/*` ref rows | zero rows on a first deploy — the table it cleans is created by the migration above |

The second is non-transactional and consolidates ONE branch per advisory lock,
100 per committed statement. On an environment that has never run this feature
it finds nothing and returns after one count query. It is safe to run again.

Apply through the normal path (`db-migrations.yml` / the deploy workflow's
migrate step). Before promoting, diff `kortix_migrations.pgmigrations` against
the promoted tree and confirm exactly these two are pending.

### Terraform

`infra/terraform/modules/ecs-api` gained `repo_snapshot_bucket` and
`repo_snapshot_prefix`. Both default to empty, and the IAM policy only exists
when the bucket is set — **applying the module with no tfvars change grants
nothing and alters nothing.** To grant the role, in the environment's tfvars:

```hcl
repo_snapshot_bucket = "kortix-repo-snapshots"
repo_snapshot_prefix = "prod/"
```

The grant is `s3:GetObject` + `s3:PutObject` on `<bucket>/<prefix>*`. There is
deliberately **no `s3:ListBucket`**: without it AWS answers 403 for a key that
does not exist, so "does this object exist" is unanswerable, which is why
publication leads with a conditional PUT and never reads 403 as absence.

---

## 3. Configuration

Non-secret, through `api_environment`:

```
KORTIX_REPO_SNAPSHOT_BUCKET=kortix-repo-snapshots
KORTIX_REPO_SNAPSHOT_REGION=us-east-2
KORTIX_REPO_SNAPSHOT_PREFIX=prod/
KORTIX_REPO_SNAPSHOT_MODE=off          # every step below changes only this
KORTIX_REPO_SNAPSHOT_COHORT=           # empty = all projects; see §5
```

Secret, through the existing env secret blob (`kortix-prod-env`):

```
KORTIX_REPO_SNAPSHOT_WEBHOOK_SECRET=…   # optional
```

Defaults that are already correct and need no entry: compression `gzip`,
delivery `presigned`, URL TTL 3600s, worker interval 5s, worker batch 2,
reconcile interval 15 min, cache TTL 360 min, cache cap 200 trees.

---

## 4. Publisher first, consumer never

Deploy with `MODE=off` and the bucket configured. The worker publishes; nothing
reads. Then backfill:

```sh
cd apps/api
dotenvx run -f .env.prod -- bun run scripts/backfill-repo-snapshots.ts \
  --dry-run --json /tmp/backfill-dry.json
dotenvx run -f .env.prod -- bun run scripts/backfill-repo-snapshots.ts \
  --json /tmp/backfill.json
```

`--dry-run` writes nothing at all, including the repository id an unregistered
project would gain. Its report lists every project it could not prepare and why;
**that list is the coverage gap, and reading it is the gate for step 5.**

Coverage gate before any project is switched on:

```sql
select count(*) filter (where status = 'ready')  as ready,
       count(*) filter (where status = 'failed') as failed,
       count(*) filter (where status in ('queued','building')) as pending
from kortix.repo_snapshots;

-- Refs with a desired revision that has no ready snapshot: the real gap.
select count(*) from kortix.repo_snapshot_refs r
where r.desired_sha is not null
  and not exists (
    select 1 from kortix.repo_snapshots s
    where s.provider = r.provider and s.repository_id = r.repository_id
      and s.commit_sha = r.desired_sha and s.status = 'ready');
```

Proceed when `failed` is understood project by project and the gap query is 0
for the projects in the canary.

---

## 5. Canary, by project

```
KORTIX_REPO_SNAPSHOT_MODE=prefer
KORTIX_REPO_SNAPSHOT_COHORT=<project-uuid>,<project-uuid>
```

Outside the cohort a project resolves to `off` and behaves exactly as it does
today. The cohort is deployment configuration, not project state: widening it,
narrowing it and emptying it are one config change and one deploy, and nothing
in the database has to be rewritten to undo it. It can never switch a project on
while the deployment-wide mode is `off`.

Watch, per boot, for the cohort's projects:

| Signal | Where | Healthy |
| --- | --- | --- |
| snapshot served | daemon health `repo_snapshot.used` | true |
| fallback reason | daemon health `repo_snapshot.fallbackReason` | absent |
| Git network operations | daemon health `git_network_ops` | 0 |
| workspace materialization | `boot_timeline` marks | at or below the Git path's |
| request → runtimeReady | `scripts/bench-boot-attribution.ts` | no regression beyond noise |

A fallback is not an incident — `prefer` is defined to fall back at the same SHA
— but a fallback RATE above a few percent means the coverage gate in §4 was read
too generously.

Expand the cohort only after a full business day at each size.

---

## 6. Deployment-wide

`KORTIX_REPO_SNAPSHOT_COHORT=` (empty) with `MODE=prefer`. Same signals, whole
fleet. Leave it here. `required` is a separate decision with its own gate: it
removes the Git fallback, so it needs every image in rotation on a
descriptor-aware daemon AND a coverage gap of 0 fleet-wide, not just for a
cohort.

---

## 7. Rollback

`KORTIX_REPO_SNAPSHOT_MODE=off` and redeploy the API. That is the whole
rollback: sessions take the Git path they take today, the published objects are
inert, and the tables keep their rows for the next attempt. To roll back part of
a cohort, remove those ids from `KORTIX_REPO_SNAPSHOT_COHORT` — identical effect
for exactly those projects.

Nothing in this feature deletes a Git mirror, rewrites a working tree, or
changes what a session can reach. The rollback is a config change, not a
restoration.

---

## 8. Verification, in order

1. **Migrations applied.** `select 1 from kortix.repo_snapshots limit 1` on the
   environment's database.
2. **The role can write.** From a task in the environment, or with the role
   assumed: `KORTIX_REPO_SNAPSHOT_TEST_MODE=aws bun test --isolate
   src/repo-snapshots/s3-publish.integration.test.ts` — that mode defaults
   nothing, probes with a signed PUT, and FAILS rather than skips when the setup
   is missing.
3. **The publisher is publishing.** `select status, count(*) from
   kortix.repo_snapshots group by 1` climbs.
4. **A cohort session uses it.** The daemon health signals in §5 for a real
   session on a cohort project.
5. **Later Git still works.** On that same session: edit, commit, push, and open
   a Kortix change request. The prepared start removes the START-time token, not
   the credential helper, the Git proxy, or operation-time authorization.
6. **Boot latency.** `scripts/bench-boot-attribution.ts` with one cohort project
   and one project outside it, interleaved, as two arms of the same run.

## 9. What this document does not cover

- **Measured production latency.** The only latency evidence today is the
  component benchmark in `docs/benchmarks/`, which is a local synthetic Git
  clone against a local MinIO on one laptop. It is not a production
  measurement and is not the rollout gate.
- **AWS-verified publication.** Every S3 assertion so far is against MinIO over
  the real S3 protocol. Step 8.2 is the first AWS evidence and has not been run.
- **Alarms.** No CloudWatch alarm is defined by this change. The signals in §5
  are queries and health fields; wiring them to alerts is a follow-up.
