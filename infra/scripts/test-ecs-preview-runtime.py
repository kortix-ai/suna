#!/usr/bin/env python3

"""Security contract for the pull request preview runtime.

`deploy-preview.yml` runs on `pull_request_target`. It therefore holds write
tokens and publish credentials while the pull request head is attacker
controlled. This file pins the invariants that keep that safe. Every assertion
below states one rule; a rule that stops being true must be deleted on purpose,
not by accident.

PR #6347 (7074ffd25e) replaced the per-PR ECS runtime with a warm Platinum or
Daytona sandbox that boots the full self-host distribution:

    old: build 3 images -> push -> infra/scripts/ecs-preview.sh deploy <pr>
         -> Fargate service on pr-<n>.preview{-api}.kortix.com
    new: build 3 images -> push -> bun tests/bin/sandbox-preview.ts deploy
         -> one sandbox per PR, own PostgreSQL/Supabase/Mailpit behind a
            provider-issued HTTPS origin, then `pnpm test -- --target-full`

The gate structure is unchanged: an approval job resolves exactly one head SHA,
three credential-free jobs build it, and one default-branch job holds the
credentials and never executes pull request code. The assertions follow the new
implementation files; each obsolete assertion is kept as a comment that records
which rule replaced it.

`infra/terraform/environments/preview` still exists and is still applied, so its
guardrails are still asserted here. `infra/scripts/ecs-preview.sh` is no longer
reachable from any workflow; this file asserts it stays disconnected.
"""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text()


WORKFLOW = read(".github/workflows/deploy-preview.yml")
# The preview runtime moved into the test package. These four files are the
# whole implementation of "boot a preview and delete it again".
PREVIEW_CLI = read("tests/bin/sandbox-preview.ts")
PREVIEW_CORE = read("tests/src/core/sandbox-preview.ts")
PREVIEW_PROVIDERS = read("tests/src/core/sandbox-preview-providers.ts")
PREVIEW_STACK = read("tests/src/core/preview-stack.ts")
PREVIEW_SOURCES = {
    "tests/bin/sandbox-preview.ts": PREVIEW_CLI,
    "tests/src/core/sandbox-preview.ts": PREVIEW_CORE,
    "tests/src/core/sandbox-preview-providers.ts": PREVIEW_PROVIDERS,
    "tests/src/core/preview-stack.ts": PREVIEW_STACK,
}
TERRAFORM = read("infra/terraform/environments/preview/main.tf")
VARIABLES = read("infra/terraform/environments/preview/variables.tf")
README = read("infra/terraform/environments/preview/README.md")

JOB_HEADING = re.compile(r"^  [a-z][a-z0-9-]*:$", re.MULTILINE)


def job(name: str) -> str:
    """Return the YAML body of one top-level job in deploy-preview.yml."""
    marker = f"\n  {name}:\n"
    if marker not in WORKFLOW:
        raise AssertionError(f"deploy-preview.yml has no job named {name}")
    body = WORKFLOW.split(marker, 1)[1]
    following = JOB_HEADING.search(body)
    return body[: following.start()] if following else body


def cli_action(name: str) -> str:
    """Return the body of one `action === '<name>'` branch of the preview CLI."""
    marker = f"action === '{name}'"
    if marker not in PREVIEW_CLI:
        raise AssertionError(f"tests/bin/sandbox-preview.ts has no {name} action")
    return PREVIEW_CLI.split(marker, 1)[1].split("\n} else", 1)[0]


def checkout_steps(text: str) -> list[str]:
    """Return the body of every actions/checkout step in a workflow fragment."""
    return [chunk.split("\n      - ", 1)[0] for chunk in text.split("- uses: actions/checkout@")[1:]]


BUILD_JOBS = ("build-api", "build-gateway", "build-web")


class PreviewApproval(unittest.TestCase):
    """One writer approves one exact SHA, and every stage revalidates it."""

    def test_preview_label_approves_one_exact_sha(self):
        self.assertIn("pull_request_target:", WORKFLOW)
        self.assertIn("branches: [main]", WORKFLOW)
        self.assertIn("github.event.action == 'labeled'", WORKFLOW)
        self.assertIn("github.event.label.name == 'preview'", WORKFLOW)
        # Automatic previews on open/synchronize would deploy unreviewed code.
        self.assertNotIn("['labeled','opened','synchronize','reopened']", WORKFLOW)
        # The approval is the label plus the live head SHA, never a stored variable.
        self.assertNotIn("KORTIX_PREVIEW_APPROVED_SHA", WORKFLOW)

        authorize = job("authorize")
        self.assertIn('case "$permission" in', authorize)
        # Widened from admin|write by #6347; still excludes read and triage.
        self.assertIn("admin|maintain|write) ;;", authorize)
        self.assertIn("*) echo \"::error::${APPROVER} has ${permission} permission;", authorize)
        # Forks never reach the sandbox, on either trigger.
        self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", WORKFLOW)
        self.assertIn('[ "$head_repo" = "$REPO" ] || {', authorize)
        self.assertIn('[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || {', authorize)
        self.assertIn('[ "$current" = "$sha" ] || {', authorize)
        self.assertIn('[[ " $labels " == *" preview "* ]] || {', authorize)
        # workflow_dispatch is a second entry point; it reads the head SHA from
        # the API and runs through the same permission, label, and SHA checks.
        self.assertIn("github.event_name == 'workflow_dispatch'", WORKFLOW)
        self.assertIn("case \"$provider\" in auto|platinum|daytona) ;; *) exit 1 ;; esac", authorize)
        self.assertIn('echo "ref=refs/pull/${num}/head"', authorize)
        # The dependency graph is pinned to the approved SHA as well.
        self.assertIn("contents/pnpm-lock.yaml?ref=${sha}", authorize)
        self.assertIn('[[ "$lockfile_sha256" =~ ^[0-9a-f]{64}$ ]] || {', authorize)

    def test_every_later_job_consumes_the_approved_sha_not_the_event_sha(self):
        # OLD: build jobs read ${{ github.event.pull_request.head.sha }} directly.
        # NEW: only the authorize job may touch the raw event SHA. Every other
        # job reads needs.authorize.outputs.sha, so a head change between the
        # label and the build cannot slip a different commit through.
        self.assertEqual(WORKFLOW.count("github.event.pull_request.head.sha"), 1)
        self.assertIn("EVENT_SHA: ${{ github.event.pull_request.head.sha }}", job("authorize"))
        for build in BUILD_JOBS:
            self.assertIn("ref: ${{ needs.authorize.outputs.sha }}", job(build))
        self.assertIn("kortix/kortix-api:pr-${{ needs.authorize.outputs.sha }}", WORKFLOW)
        self.assertIn("kortix/kortix-gateway:pr-${{ needs.authorize.outputs.sha }}", WORKFLOW)
        self.assertIn("kortix/kortix-frontend:pr-${{ needs.authorize.outputs.sha }}", WORKFLOW)

    def test_deploy_revalidates_permission_label_and_sha_before_publishing(self):
        deploy = job("deploy")
        self.assertIn("needs: [authorize, build-api, build-gateway, build-web]", deploy)
        self.assertIn("Revalidate exact preview approval", deploy)
        self.assertIn("admin|maintain|write) ;;", deploy)
        self.assertIn('[ "$current" = "$COMMIT" ] || {', deploy)
        self.assertIn('[[ " $labels " == *" preview "* ]] || {', deploy)

    def test_the_sandbox_refuses_to_run_any_other_sha(self):
        # OLD: `[ "$api_commit" = "$COMMIT" ]` polled the deployed ALB.
        # NEW: the bootstrap script verifies the checkout itself and then the
        # in-sandbox health endpoint, so an unapproved SHA cannot serve traffic.
        self.assertIn('git -C "$ROOT" checkout --detach --force FETCH_HEAD', PREVIEW_CORE)
        self.assertIn('test "$actual_sha" = "${input.sha}"', PREVIEW_CORE)
        self.assertIn("pnpm install --offline --frozen-lockfile", PREVIEW_CORE)
        self.assertIn("if (!/^[a-f0-9]{40}$/i.test(input.sha)) throw new Error", PREVIEW_CORE)
        self.assertIn("preview lockfile hash must contain 64 hex characters", PREVIEW_CORE)
        self.assertIn("PREVIEW_LOCKFILE_SHA256: ${{ needs.authorize.outputs.lockfile_sha256 }}", WORKFLOW)


class PreviewBuildIsolation(unittest.TestCase):
    """Pull request code compiles without credentials and never executes on the runner."""

    def test_no_checkout_persists_credentials(self):
        # OLD: assertEqual(count("persist-credentials: false"), 3) — the count
        # broke as soon as #6347 added checkouts. The rule was never "three";
        # it is "every checkout in this workflow".
        steps = checkout_steps(WORKFLOW)
        self.assertEqual(len(steps), WORKFLOW.count("- uses: actions/checkout@"))
        self.assertGreaterEqual(len(steps), 6)
        for step in steps:
            self.assertIn("persist-credentials: false", step)

    def test_build_jobs_have_no_secret_no_registry_and_no_push(self):
        self.assertEqual(WORKFLOW.count("push: false"), 3)
        self.assertEqual(WORKFLOW.count("type=docker,dest=/tmp/preview-"), 3)
        self.assertEqual(WORKFLOW.count("actions/download-artifact@v8"), 3)
        for name in BUILD_JOBS:
            section = job(name)
            self.assertIn("permissions:\n      contents: read", section)
            self.assertIn("submodules: false", section)
            self.assertEqual(section.count("actions/upload-artifact@v7"), 1)
            self.assertIn("if-no-files-found: error", section)
            self.assertNotIn("${{ secrets.", section)
            self.assertNotIn("DOCKERHUB_", section)
            self.assertNotIn("docker/login-action", section)
            self.assertNotIn("push: true", section)
            self.assertNotIn("aws-actions/configure-aws-credentials", section)

    def test_the_credentialed_job_loads_images_and_never_runs_them(self):
        deploy = job("deploy")
        self.assertIn("ref: ${{ github.event.repository.default_branch }}", deploy)
        # The privileged runner must not check out pull request code at all.
        self.assertNotIn("ref: ${{ needs.authorize.outputs.sha }}", deploy)
        self.assertIn("docker/login-action@v3", deploy)
        self.assertIn("docker load --input", deploy)
        self.assertIn("docker push", deploy)
        self.assertIn(
            "docker image inspect --format '{{.Os}}/{{.Architecture}}' \"$image\" | grep -qx 'linux/amd64'",
            deploy,
        )
        self.assertNotIn("docker run", deploy)
        self.assertNotIn("docker compose", deploy)
        # Pull request code executes only inside the disposable sandbox.
        self.assertIn("bun tests/bin/sandbox-preview.ts deploy", deploy)

    def test_a_failed_preview_cannot_report_success(self):
        deploy = job("deploy")
        self.assertIn("continue-on-error: true", deploy)
        self.assertIn("if: steps.preview.outcome != 'success'", deploy)
        self.assertIn("run: exit 1", deploy)

    def test_the_preview_pipeline_holds_no_cloud_or_delivery_identity(self):
        # OLD: the deploy and teardown jobs assumed
        # arn:aws:iam::…:role/kortix-gha-preview-deploy through OIDC. The
        # sandbox runtime needs no AWS identity, so the workflow must not
        # request one, and the disconnected ECS path must stay disconnected.
        self.assertNotIn("aws-actions/configure-aws-credentials", WORKFLOW)
        self.assertNotIn("id-token: write", WORKFLOW)
        self.assertNotIn("ecs-preview.sh", WORKFLOW)
        self.assertNotIn("Vercel", WORKFLOW)
        self.assertNotIn("VERCEL_", WORKFLOW)
        self.assertNotIn("Argo CD", WORKFLOW)
        self.assertNotIn("submodule update --init --recursive --remote", WORKFLOW)


class PreviewRuntimeIsolation(unittest.TestCase):
    """One sandbox per pull request, its own data plane, no production reach."""

    def test_each_pull_request_gets_one_named_sandbox(self):
        # OLD: SERVICE="kortix-pr-${PR}" plus pr-<n>.preview{-api}.kortix.com.
        # NEW: one stable sandbox name per PR; the origin is provider-issued.
        self.assertIn("return `kortix-preview-pr-${prNumber}`;", PREVIEW_CORE)
        self.assertIn("invalid preview PR number", PREVIEW_CORE)
        # Both providers name the sandbox after the PR: Daytona directly, and
        # Platinum through previewSandboxIdentity, whose PR branch is the same
        # call. Neither may improvise a name.
        self.assertIn("name: previewSandboxName(input.prNumber),", PREVIEW_PROVIDERS)
        self.assertIn("name: previewSandboxName(input.prNumber),", PREVIEW_CORE)
        self.assertIn("name: identity.name,", PREVIEW_PROVIDERS)
        # A branch environment is named after the BRANCH and reused in place, so
        # its origin survives a push. Daytona issues its own URL, so falling back
        # there would break exactly that — it must refuse rather than rotate.
        self.assertIn("return `kortix-env-${slug}`;", PREVIEW_CORE)
        self.assertIn("reuseExisting: true,", PREVIEW_CORE)
        # A reused sandbox is still serving the previous deploy, so it can never
        # satisfy the warm check ("restored, nothing running") — waiting on it
        # timed out at 120s and the cleanup below then deleted the environment.
        self.assertIn("if (!reusable) {", PREVIEW_PROVIDERS)
        # ...and cleanup deletes only a sandbox this run CREATED. Deleting a
        # reused one discards the stable origin the environment exists to hold.
        self.assertIn("if (sandboxId && !reusedSandboxId) await deletePlatinum(", PREVIEW_PROVIDERS)
        self.assertIn("if (input.branchEnv) {", PREVIEW_PROVIDERS)
        self.assertIn("is pinned to Platinum: a Daytona fallback would change its origin", PREVIEW_PROVIDERS)
        # OLD: rollback_deploy / PREVIOUS_TASK_DEFINITION rolled a live service
        # back. A sandbox is disposable, so a redeploy deletes and recreates it.
        self.assertIn("async function replaceExistingPlatinumPreview(", PREVIEW_PROVIDERS)
        self.assertIn("async function replaceExistingDaytonaPreview(", PREVIEW_PROVIDERS)
        self.assertIn("refused to replace unowned Daytona sandbox", PREVIEW_PROVIDERS)
        # The owner a PR preview is stamped with (previewSandboxIdentity) is the
        # same one every destructive read filters on, so a redeploy, a teardown,
        # and the nightly sweep can only ever touch a sandbox this system made.
        self.assertIn("owner: 'kortix-preview',", PREVIEW_CORE)
        self.assertIn("owner: identity.owner,", PREVIEW_PROVIDERS)
        # Every destructive read filters on the owner this system stamps, so a
        # redeploy, a teardown and the nightly sweep can only ever touch a
        # sandbox it created. The replace path checks it in the provider; the
        # teardown and sweep selectors check it in core.
        self.assertEqual(PREVIEW_PROVIDERS.count("sandbox.metadata?.owner === 'kortix-preview'"), 1)
        self.assertIn("sandbox.name === ephemeral &&", PREVIEW_CORE)
        self.assertIn("owner === 'kortix-preview' &&", PREVIEW_CORE)
        self.assertIn("sandbox.name === persistent && owner === 'kortix-branch-env'", PREVIEW_CORE)
        self.assertIn("'kortix-preview': 'true',", PREVIEW_PROVIDERS)
        # A provider switch must not leave the other provider's sandbox running.
        self.assertIn(
            "const staleProviderCleanup = result.provider === 'platinum'",
            cli_action("deploy"),
        )

    def test_the_preview_origin_is_credential_free_https(self):
        # OLD: WEB_PROTECTION_PASSWORD plus the anonymous/wrong/cookie_only
        # probes guarded pr-<n>.preview.kortix.com, a guessable public hostname.
        # NEW: there is no Kortix hostname and no HTTP password. The origin is a
        # per-sandbox provider URL, and both the URL and the compose overlay are
        # validated. The blast radius is bounded by the data-plane isolation
        # asserted below, not by a shared password.
        self.assertIn("sandbox preview URL must use credential-free HTTPS", PREVIEW_PROVIDERS)
        self.assertIn("if (url.protocol !== 'https:' || url.username || url.password)", PREVIEW_PROVIDERS)
        self.assertIn("preview origin must be an HTTPS origin", PREVIEW_CORE)
        self.assertIn("preview origin must be an HTTPS origin without a path", PREVIEW_STACK)
        for path, source in PREVIEW_SOURCES.items():
            self.assertNotIn("kortix.com", source, f"{path} must not pin a Kortix hostname")
        # An operator MAY front an environment with a stable name, but it arrives
        # as configuration (PREVIEW_PUBLIC_ORIGIN) and is validated like any
        # other origin — the sources above still name no host of their own.
        self.assertIn("PREVIEW_PUBLIC_ORIGIN", PREVIEW_CLI)
        self.assertIn(
            "const origin = input.publicOrigin ? validatedPreviewUrl(input.publicOrigin) : sandboxOrigin;",
            PREVIEW_PROVIDERS,
        )
        # The provider origin is always reported, because whatever serves the
        # stable name has to be told which sandbox to send traffic to.
        self.assertIn("sandboxOrigin,", PREVIEW_PROVIDERS)

    def test_only_the_edge_port_is_published_and_the_gateway_stays_internal(self):
        # OLD: LLM_GATEWAY_PROXY_TARGET http://127.0.0.1:8090, an API container
        # port 3000 for web, and two ALB target groups.
        # NEW: one Caddy edge on 8080 fronts everything; the gateway, API,
        # frontend, and Supabase are reachable only inside the compose network.
        self.assertIn("reverse_proxy kortix-api:8008", PREVIEW_STACK)
        self.assertIn("reverse_proxy llm-gateway:8090", PREVIEW_STACK)
        self.assertIn("reverse_proxy frontend:3000", PREVIEW_STACK)
        self.assertIn("handle_path /_gateway/*", PREVIEW_STACK)
        self.assertIn('- "0.0.0.0:8080:8080"', PREVIEW_STACK)
        # The database port is bound to loopback inside the sandbox only.
        self.assertIn('- "127.0.0.1:15432:5432"', PREVIEW_STACK)
        self.assertIn("expose: [{ port: 8080, public: true }]", PREVIEW_PROVIDERS)

    def test_the_preview_runs_its_own_data_plane_in_preview_mode(self):
        # OLD: INTERNAL_KORTIX_ENV=preview, KORTIX_WORKERS_ENABLED=false, and
        # KORTIX_SKIP_ENSURE_SCHEMA=1 on a shared preview database.
        # NEW: the same environment marker and worker switch, and the schema
        # flag is obsolete because each preview creates its own PostgreSQL.
        self.assertIn("INTERNAL_KORTIX_ENV: 'preview',", PREVIEW_STACK)
        self.assertIn("KORTIX_WORKERS_ENABLED: 'false',", PREVIEW_STACK)
        self.assertIn("SCHEDULER_ENABLED: 'false',", PREVIEW_STACK)
        self.assertIn("KORTIX_TRIGGER_SCHEDULER_ENABLED: 'false',", PREVIEW_STACK)
        self.assertIn(
            "DATABASE_URL: `postgresql://postgres:${postgresPassword}@supabase-db:5432/postgres`,",
            PREVIEW_STACK,
        )
        self.assertIn(
            "KE2E_DATABASE_URL: `postgresql://postgres:${postgresPassword}@127.0.0.1:15432/postgres`,",
            PREVIEW_STACK,
        )
        # A preview must never deliver real email.
        self.assertIn("EMAIL_PROVIDER_ORDER: 'mailpit',", PREVIEW_STACK)
        self.assertIn("SMTP_HOST: 'mailpit',", PREVIEW_STACK)
        # OLD: NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_BACKEND_URL were set to the two
        # per-PR hostnames. NEW: every public URL is the one validated origin.
        for key in (
            "PUBLIC_URL: origin,",
            "API_PUBLIC_URL: origin,",
            "SUPABASE_PUBLIC_URL: origin,",
            "CORS_ALLOWED_ORIGINS: origin,",
            "KORTIX_PUBLIC_APP_URL: origin,",
        ):
            self.assertIn(key, PREVIEW_STACK)
        # OLD: KORTIX_PUBLIC_VERSION carried the commit into the UI.
        self.assertIn("KORTIX_VERSION: `pr-${input.sha}`,", PREVIEW_STACK)
        self.assertIn("KORTIX_COMMIT: input.sha,", PREVIEW_STACK)
        self.assertIn("KE2E_EXPECT_SHA: input.sha,", PREVIEW_STACK)

    def test_runtime_secrets_are_allowlisted_and_delivered_per_sandbox(self):
        # OLD: SECRET_NAME="kortix-preview-env" / "kortix-preview-web-env" in
        # Secrets Manager, with `assertNotIn("kortix-prod-env")` as the guard.
        # NEW: an explicit allowlist decides what may enter a preview, and the
        # values land in one 0600 file inside the sandbox.
        self.assertIn("export const PREVIEW_RUNTIME_SECRET_ALLOWLIST = [", PREVIEW_STACK)
        for name in (
            "'DAYTONA_API_KEY',",
            "'KE2E_STRIPE_SECRET_KEY',",
            "'KE2E_STRIPE_WEBHOOK_SECRET',",
            "'KORTIX_GITHUB_APP_ID',",
            "'KORTIX_GITHUB_APP_PRIVATE_KEY',",
            "'KORTIX_GITHUB_APP_SLUG',",
            "'MANAGED_GIT_GITHUB_INSTALL_ID',",
            "'MANAGED_GIT_GITHUB_OWNER',",
            "'OPENROUTER_API_KEY',",
        ):
            self.assertIn(name, PREVIEW_STACK)
        self.assertIn("preview runtime secret is not allowlisted", PREVIEW_STACK)
        self.assertIn("validatePreviewRuntimeSecrets(rawSecrets);", PREVIEW_STACK)
        self.assertIn("/workspace/kortix-preview/runtime-secrets.json", PREVIEW_PROVIDERS)
        # Platinum passes the mode explicitly; Daytona uses the 0600 default of
        # encodedFileCommand. Both secret writes must stay owner-only.
        platinum_write = PREVIEW_PROVIDERS.split(
            "`${sandboxId}:/workspace/kortix-preview/runtime-secrets.json`", 1
        )[1].split(");", 1)[0]
        self.assertIn("'0600'", platinum_write)
        self.assertIn("mode = '0600'", PREVIEW_PROVIDERS)
        daytona_write = PREVIEW_PROVIDERS.split(
            "'/workspace/kortix-preview/runtime-secrets.json',", 1
        )[1].split("),", 1)[0]
        self.assertNotIn("'07", daytona_write)
        # No production identity may reach a preview, on any surface.
        for path, source in list(PREVIEW_SOURCES.items()) + [("deploy-preview.yml", WORKFLOW)]:
            self.assertNotIn("kortix-prod-env", source, path)
            self.assertNotIn("PROD_", source, path)
            self.assertNotIn("STAGING_DATABASE_URL", source, path)


class PreviewTeardown(unittest.TestCase):
    """Unlabel, branch delete, new head, and the nightly sweep, each by its own rule."""

    def test_unlabel_and_branch_delete_run_complete_default_branch_teardown(self):
        # WAS: `closed` tore the environment down. That is the wrong event.
        # Closing a pull request is routine — superseded, reopened later, split
        # in two — and none of it means the work is finished, yet it destroyed a
        # live environment and its Postgres volume. An environment belongs to
        # its BRANCH, so exactly two things retire it: the `preview` label coming
        # off (the explicit switch) and the branch being deleted.
        teardown = job("teardown")
        self.assertNotIn("github.event.action == 'closed'", WORKFLOW)
        self.assertIn("types: [labeled, unlabeled, synchronize]", WORKFLOW)
        self.assertIn("github.event.action == 'unlabeled' && github.event.label.name == 'preview'", WORKFLOW)
        self.assertIn("github.event.action == 'synchronize'", WORKFLOW)
        # Teardown runs default-branch code, never the pull request head.
        self.assertIn("ref: ${{ github.event.repository.default_branch }}", teardown)
        # OLD: bash infra/scripts/ecs-preview.sh teardown "$NUM".
        self.assertIn("bun tests/bin/sandbox-preview.ts teardown", teardown)

        # The branch-deleted job. `ref_type` gates out tag deletions, which
        # arrive on the same event and name no branch. It has no pull request to
        # patch, so it takes no write scope and calls no GitHub API — and it
        # still reads default-branch code only.
        self.assertIn("\n  delete:\n", WORKFLOW)
        branch_teardown = job("teardown-branch")
        self.assertIn(
            "github.event_name == 'delete' && github.event.ref_type == 'branch'", branch_teardown
        )
        self.assertIn("PREVIEW_BRANCH_ENV: ${{ github.event.ref }}", branch_teardown)
        self.assertNotIn("\n      PREVIEW_PR_NUMBER:", branch_teardown)
        self.assertIn("ref: ${{ github.event.repository.default_branch }}", branch_teardown)
        self.assertIn("persist-credentials: false", branch_teardown)
        self.assertNotIn("pull-requests: write", branch_teardown)
        self.assertNotIn("deployments: write", branch_teardown)
        self.assertNotIn("gh api", branch_teardown)
        self.assertIn("bun tests/bin/sandbox-preview.ts teardown", branch_teardown)

        # OLD: aws ecs delete-service / elbv2 delete-rule / delete-target-group
        # / ecs deregister-task-definition removed the four ECS resources.
        # NEW: one sandbox holds the whole stack, so teardown deletes it on both
        # providers and refuses to touch a sandbox it does not own.
        teardown_action = cli_action("teardown")
        # Both shapes are deleted, and either key alone is enough: the PR-named
        # sandbox when a number is known, the branch-named one when a branch is.
        self.assertIn("...(prNumber === undefined ? {} : { prNumber }),", teardown_action)
        self.assertIn("...(branchEnv ? { branchEnv } : {}),", teardown_action)
        # Daytona only ever holds the EPHEMERAL shape — a branch environment is
        # pinned to Platinum — and its teardown is keyed by pull request number,
        # so a branch-only teardown has nothing to ask it for.
        self.assertIn(
            "prNumber === undefined ? Promise.resolve(0) : teardownDaytonaPreview({ ...daytona, prNumber })",
            teardown_action,
        )
        self.assertIn("refused to delete unowned Daytona sandbox", PREVIEW_PROVIDERS)
        self.assertIn("sandbox.metadata?.owner === 'kortix-preview' &&", PREVIEW_PROVIDERS)
        self.assertIn("Mark GitHub deployment inactive", teardown)
        self.assertNotIn("branch-scoped Vercel", WORKFLOW)

    def test_a_new_head_sha_redeploys_instead_of_revoking_the_approval(self):
        # WAS: a push deleted the sandbox AND stripped the `preview` label, so
        # every push cost a human re-approval and a NEW url. A labelled preview
        # now stays online until the label comes off or the pull request closes.
        #
        # The approval bar is unchanged, only re-expressed: `authorize` still
        # runs on the push, still accepts SAME-REPOSITORY pull requests only, and
        # still requires the actor to hold write. On `synchronize` that actor is
        # whoever pushed — who necessarily already holds write on this
        # repository — so nothing is loosened. The exact-SHA revalidation before
        # deploy is untouched.
        authorize = job("authorize")
        self.assertIn("github.event.action == 'synchronize'", authorize)
        self.assertIn(
            "contains(github.event.pull_request.labels.*.name, 'preview')", authorize
        )
        self.assertIn(
            "github.event.pull_request.head.repo.full_name == github.repository", authorize
        )
        # A branch MAY be fronted by a stable hostname; every branch keeps the
        # provider origin unless PREVIEW_PUBLIC_ORIGINS lists it, and the entry
        # must be https or the deploy refuses rather than configuring the stack
        # with an origin the browser will never use.
        self.assertIn("PUBLIC_ORIGINS: ${{ vars.PREVIEW_PUBLIC_ORIGINS }}", authorize)
        self.assertIn("''|https://*) ;;", authorize)
        # A stable hostname is proxied to the sandbox's OWN origin, which is
        # derived from the sandbox id — so it dies on a rebuild unless the deploy
        # re-points it. The optional third field names the worker that serves it;
        # it is constrained so it cannot escape the workers directory.
        self.assertIn("public_worker=", authorize)
        self.assertIn("''|*[!a-z0-9-]*)", authorize)
        deploy = job("deploy")
        self.assertIn("Point the stable hostname at this sandbox", deploy)
        self.assertIn("needs.authorize.outputs.public_worker != ''", deploy)
        # NOT gated on the suite: a failing flow still leaves a working
        # environment, and a hostname left pointing at the previous sandbox —
        # or at nothing — is worse than a red flow.
        self.assertIn("if: always() && needs.authorize.outputs.public_worker != ''", deploy)
        self.assertIn('dir="infra/cloudflare/workers/${WORKER}"', deploy)
        self.assertIn('wrangler@4 deploy --var "TARGET_ORIGIN:${target}"', deploy)
        self.assertIn(
            "PREVIEW_PUBLIC_ORIGIN: ${{ needs.authorize.outputs.public_origin }}", job("deploy")
        )
        # Making every labelled preview persistent turned the --target-full gate
        # OFF by default, because runTests defaults off once branchEnv is set.
        # The suite must still run when the label goes on; only a redeploy from a
        # push skips it, so pushes stay fast without losing the gate.
        self.assertIn(
            "PREVIEW_RUN_TESTS: ${{ (github.event.action == 'labeled' || "
            "github.event_name == 'workflow_dispatch') && '1' || '0' }}",
            job("deploy"),
        )

        teardown = job("teardown")
        # A push must no longer tear anything down, and must not strip the label.
        self.assertNotIn("synchronize", teardown)
        self.assertNotIn("labels/preview", teardown)
        # Nor may closing the pull request: removing the label is the only pull
        # request action that retires an environment.
        self.assertNotIn("github.event.action == 'closed'", teardown)
        self.assertIn("github.event.label.name == 'preview'", teardown)

    def test_the_nightly_sweep_deletes_only_unapproved_sandboxes(self):
        # OLD: MAX_ACTIVE_PREVIEWS=20 and PREVIEW_MAX_AGE_HOURS=72 bounded a
        # shared cluster; "preserving its preview" kept the live PR's service.
        # NEW: the bound is one sandbox per open, labeled PR at its current head
        # SHA, plus provider-side archive and delete after seven days.
        self.assertIn("bun tests/bin/sandbox-preview.ts reconcile", job("reconcile"))
        self.assertIn('cron: "17 6 * * *"', WORKFLOW)
        reconcile_action = cli_action("reconcile")
        self.assertIn(
            "reconcilePlatinumPreviews({ ...platinum, activePullRequests: active, liveBranchSandboxNames })",
            reconcile_action,
        )
        self.assertIn(
            "reconcileDaytonaPreviews({ ...daytona, activePullRequests: active })", reconcile_action
        )
        self.assertIn("selectStalePreviewSandboxIds", PREVIEW_CORE)
        # Both owners are reaped, by different rules, because they are identified
        # by different things. An EPHEMERAL preview is built for exactly one
        # commit of one pull request, so a closed pull request or a moved head
        # makes it stale. A BRANCH environment is redeployed in place — a moved
        # head is its normal state, and sweeping on sha would delete a live
        # environment on every push. It is retired by its branch disappearing.
        self.assertIn("return !activeSha || activeSha !== sandbox.metadata?.git_sha;", PREVIEW_CORE)
        self.assertIn("if (owner !== 'kortix-preview') return false;", PREVIEW_CORE)
        self.assertIn(
            "return !liveBranchSandboxNames.has(sandbox.name);",
            PREVIEW_CORE,
        )
        # The name is the ONLY record of which branch a sandbox belongs to.
        # Deleting one that has none would turn a listing that stopped returning
        # names into the loss of every branch environment and its volume.
        self.assertIn("if (sandbox.name === undefined) return false;", PREVIEW_CORE)
        self.assertIn("const approved = pull.labels?.some((label) => label.name === 'preview');", PREVIEW_CLI)
        self.assertIn("const sameRepository = pull.head?.repo?.full_name === repository;", PREVIEW_CLI)
        # A PR preview is swept after 7 idle days; the Platinum retention now
        # comes from previewSandboxIdentity, which is where the 7 lives.
        self.assertIn("auto_archive_days: identity.autoArchiveDays,", PREVIEW_PROVIDERS)
        self.assertIn("auto_delete_days: identity.autoDeleteDays,", PREVIEW_PROVIDERS)
        self.assertIn("autoArchiveDays: 7,", PREVIEW_CORE)
        self.assertIn("autoDeleteDays: 7,", PREVIEW_CORE)
        self.assertIn("autoArchiveInterval: 10_080,", PREVIEW_PROVIDERS)
        self.assertIn("autoDeleteInterval: 10_080,", PREVIEW_PROVIDERS)
        # A branch environment carries NO provider expiry — it is retired by the
        # `preview` label coming off or by its BRANCH being deleted, and nothing
        # else. Teardown must therefore know the branch, or the box outlives
        # everything and bills until a human notices.
        self.assertIn("owner: 'kortix-branch-env',", PREVIEW_CORE)
        self.assertIn("autoArchiveDays: 0,", PREVIEW_CORE)
        self.assertIn("autoDeleteDays: 0,", PREVIEW_CORE)
        self.assertIn("branchEnvSandboxName(input.branchEnv)", PREVIEW_CORE)
        self.assertIn("selectTeardownSandboxIds(await allPlatinumPreviewSandboxes(api), input)", PREVIEW_PROVIDERS)
        self.assertIn("PREVIEW_BRANCH_ENV", job("teardown"))

    def test_a_failed_pull_request_query_never_reads_as_no_active_previews(self):
        # OLD: assertNotIn("|| printf closed") — a shell fallback that turned a
        # GitHub API error into "the PR is closed" and deleted a live preview.
        # NEW: the reconciler throws instead of returning an empty active set.
        self.assertIn(
            "if (!response.ok) throw new Error(`GitHub pull request list returned ${response.status}`);",
            PREVIEW_CLI,
        )
        self.assertIn("if (pulls.length < 100) return active;", PREVIEW_CLI)
        # The same rule for the branch listing, which now decides the life of
        # every branch environment. An empty set means "every branch is gone",
        # so failing open here would delete all of them in one sweep.
        self.assertIn(
            "if (!response.ok) throw new Error(`GitHub branch list returned ${response.status}`);",
            PREVIEW_CLI,
        )
        self.assertIn("if (branches.length < 100) return names;", PREVIEW_CLI)


class PreviewHealthGate(unittest.TestCase):
    """The preview proves it is the approved build before it is published."""

    def test_deploy_requires_exact_api_health_and_the_full_deployed_suite(self):
        # OLD: the workflow polled https://pr-<n>.preview-api.kortix.com/v1/health
        # for `.environment == "preview"` and `.commit == $COMMIT`, and the
        # frontend for `.commit`. NEW: the bootstrap script runs the same
        # assertion against the sandbox origin, then runs the deployed suite.
        self.assertIn(
            '\'.status == "ok" and .environment == "preview" and .commit == $sha\'',
            PREVIEW_CORE,
        )
        self.assertIn("docker compose --project-name kortix-${instance}", PREVIEW_CORE)
        self.assertIn("up -d --wait --wait-timeout 300", PREVIEW_CORE)
        self.assertIn("condition: service_healthy", PREVIEW_STACK)
        self.assertIn("pnpm test -- --target-full", PREVIEW_CORE)
        self.assertIn("Deploy sandbox and run pnpm test -- --target-full", WORKFLOW)

    def test_provider_fallback_hides_no_product_failure(self):
        # New rule with #6347: `auto` may retry on Daytona only when Platinum
        # infrastructure fails. A failing test run or a controller bug must
        # surface, not trigger a second, greener attempt.
        self.assertIn("if (!(error instanceof PreviewInfrastructureError)) throw error;", PREVIEW_CORE)
        self.assertIn("if (input.provider === 'platinum') return runners.platinum(input);", PREVIEW_CORE)
        self.assertIn("if (input.provider === 'daytona') return runners.daytona(input);", PREVIEW_CORE)
        self.assertIn("PREVIEW_SANDBOX_PROVIDER must be auto, platinum, or daytona", PREVIEW_CLI)


class SharedPreviewEdge(unittest.TestCase):
    """The ECS preview root no longer serves previews but is still applied."""

    # `infra/terraform/environments/preview` provisions a real ALB, WAF, DNS
    # records, and a GitHub OIDC role in account 935064898258. #6347 stopped
    # using them; it did not destroy them. Until the root is removed, its
    # guardrails stay gated here. Retiring it must delete this class and the
    # root together.

    def test_shared_edge_has_tls_waf_logs_and_preview_only_oidc_role(self):
        for fragment in (
            'name = "kortix-preview"',
            "certificate_arn   = var.preview_certificate_arn",
            'resource "aws_wafv2_web_acl_association" "preview"',
            "drop_invalid_header_fields = true",
            "enable_deletion_protection = true",
            'name    = "*.preview-api"',
            'name    = "*.preview"',
            'domain_name = "*.preview.kortix.com"',
            'resource "aws_lb_listener_certificate" "frontend"',
            'data "aws_secretsmanager_secret" "web"',
            'name = "kortix-preview-web-env"',
            "proxied = false",
            'name = "kortix-gha-preview-deploy"',
            '"repo:kortix-ai/suna:pull_request"',
            '"repo:kortix-ai/suna:ref:refs/heads/main"',
            '"token.actions.githubusercontent.com:job_workflow_ref" = "kortix-ai/suna/.github/workflows/deploy-preview.yml@refs/heads/main"',
            'description = "DNS over UDP"',
            'resource "aws_iam_role_policy" "execution_logs_kms"',
            'resource "aws_wafv2_web_acl" "preview"',
            'name        = "AWSManagedRulesKnownBadInputsRuleSet"',
            'resource "aws_wafv2_web_acl_logging_configuration" "preview"',
        ):
            self.assertIn(fragment, TERRAFORM)

    def test_database_egress_and_bootstrap_are_bounded(self):
        self.assertIn("cidr_blocks = var.postgres_egress_cidrs", TERRAFORM)
        self.assertIn('!contains(var.postgres_egress_cidrs, "0.0.0.0/0")', VARIABLES)
        for heading in ("## Existing-resource import", "## Cutover", "## Reconciliation and rollback"):
            self.assertIn(heading, README)


if __name__ == "__main__":
    unittest.main()
