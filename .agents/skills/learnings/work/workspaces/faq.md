# Workspaces — hard questions, answered

Facts from code at `workspaces` `d56ef2ec82` and read-only prod aggregates
(2026-11-05). "PR 1" is the first Workspaces PR; "later" names the stage.

## Billing

**How does billing work?** Per workspace. A workspace is an account plus its
one project, and every billing record is already per account: the wallet
(`credit_accounts`), plan and Stripe subscription, Stripe customer
(`billing_customers`), enterprise contract and entitlement overrides. Nothing
in billing moves. Members are unlimited and share the workspace's credits; no
seats exist.

**Can a person farm free credits by creating workspaces?** Today yes, and PR 1
makes creation one click, so PR 1 closes it. The free grant is 500 credits a
month per account (`billing/services/free-tier.ts:22`, rotation
`free-tier-rotation.ts:43`), with no per-person cap, no card, no rate limit on
account creation, no captcha. Managed models are paid-only, so free credits buy
compute, storage and BYOK fees only. Prod: 34,980 accounts hold a grant
(median 16 credits); 24 people own 2+ accounts (max 13).

- **PR 1 rule:** the free grant and its monthly rotation apply to the first
  workspace a person creates. Every further workspace that person creates
  starts on Free with 0 credits and asks for credits before it runs a
  session. Self-host (billing off) is unaffected.
- **How a second workspace says so (built):** `GET /v1/billing/account-state`
  returns `credits.free_grant {eligible:false, claimed_workspace_id}`,
  `tier.monthly_credits: 0` and `credits.expires_at: null`. The Plan card, the
  billing pane and the billing modal print one line ("This workspace has no
  free credits. Your monthly free credits are on <workspace>."), and the modal
  opens on the top-up for a Free workspace below the run floor (flow
  `BILL-WS-1`).
- **Exception, the split:** a project split off a free legacy account keeps
  free-credit eligibility and gets one Free grant (no `free_credit_claims`
  row): the person did not choose a second workspace.

**What about the plan caps?** No plan caps workspaces or projects: one
workspace holds one project, and a person may create any number of
workspaces on Free (only the first gets the free credits). The real
per-workspace limits are Apps, Files and the model rate budget. Pricing copy
says "500 credits a month on your first workspace" and no longer names a
project or workspace count (finding 33).

**One company, several workspaces, one bill?** Not today: N workspaces are N
Stripe customers, N subscriptions, N wallets, N contracts. Prod has 1 active
enterprise contract, on 1 account. Decision: no layer above workspaces until a
customer asks (the Slack Enterprise Grid step). When one does: an org that owns
workspaces, with one contract, pooled credits and one SSO domain.

**Mobile purchases (RevenueCat)?** The app user id is the person. The webhook
(`resolveRevenueCatAccountId`) bills, in order: the account that already holds
the store subscription (renewals, cancellations), the workspace named in the
`kortix_workspace_id` subscriber attribute when the person is a member of it,
else the person's default account. The mobile app sets that attribute to the
current workspace before a purchase (web stream). A person with no workspace:
the event is acknowledged and grants nothing.

**Can the legacy Stripe sync move a subscription between workspaces?** No
(finding 8). It never matches customers by email. It adopts only a
subscription of the account's own customer, or of an unmapped customer whose
subscription names this account; never one whose `metadata.account_id` names
another live account, and never one another `credit_accounts` row holds (I11).
It runs only from `POST /v1/billing/sync-subscription`, never on the request
path.

**What does a split-off workspace pay?** A free source: Free with free-credit
eligibility and one Free grant. A paying source (paid plan): the keeper's plan
comped, no Stripe subscription, until min(the keeper's period end, now + 31 d)
(`credit_accounts.comp_plan_until`), with the plan credits pro-rated to that
window; then Free with free credits (`billing/services/split-off-billing.ts`).
account-state shows `plan_comp`; the Plan card reads "No charge until <date>,
then Free" (flow `BILL-WS-2`).

**Where does a moved project's cost history go?** The ledgers stay with the
account that paid. Workspace and session cost views read by `project_id`, so
the moved workspace sees its full history, each row marked `billed_elsewhere`.
The payer's per-project rollup labels it "Moved to another workspace"
(finding 31).

## Migrating existing accounts

PR 1 needs no data migration.

| Today (prod) | After PR 1 |
|---|---|
| 8,049 accounts with exactly 1 project | already a workspace; nothing changes |
| 40,618 accounts with 0 projects (auto-created personal accounts) | not listed as a workspace. "Create workspace" reuses the person's newest empty owned account, so any plan or credits on it stay |
| 401 accounts with 2+ projects (1,034 projects; 25 active, 11 active and paying, 0 with SSO, 0 with an enterprise contract) | each project shows as its own workspace row; they share billing and members until the split |
| 49,032 people with a membership | sign-in unchanged; the last-workspace cookie lands them where they were |

**The split (later, stage 9b).** `transferProjectOwnership`
(`projects/lib/project-transfer.ts:255`) already moves a project to another
account in one transaction (44 tables). Gaps the split closes first:

1. Unclassified tables: `session_pending_permissions`, `audit_activity_daily`.
2. Live bug: `app_site_files`, `app_site_blobs`, `app_volumes`, `app_runtimes`
   keep the old `account_id`, so a moved app's static site breaks and the old
   account keeps paying its compute. Fixed forward on `dev` as its own bug.
3. Copy, not move: account-wide secrets (re-encrypt per account) and their
   grants and session pools; groups and custom roles (today the transfer
   deletes those grants); GitHub installations and user tokens; Claude/ChatGPT
   logins; audit webhooks; account security settings and branding.
4. Members: every person with a grant on the moved project gets a membership
   and a role in the new account; owners and admins are re-added.
5. Invites: an account invite can carry grants for several projects; it is
   split per new account.
6. Money stays: balance, Stripe subscription and history stay with the
   account that keeps the most active project (most sessions in the last 30 days). The others start on
   Free (the 11 paying accounts choose first).

## Self-host

**Can anyone create infinite workspaces?** By design, on the operator's own
hardware with billing off (`KORTIX_BILLING_INTERNAL_ENABLED=false`, the CLI
default): no credits, no caps, no money at risk. Who may create is the
operator's choice:

- `KORTIX_RESTRICT_ACCOUNT_CREATION=true` (CLI default): only platform admins
  (`KORTIX_PLATFORM_ADMIN_EMAILS` or a `platform_user_roles` row) create
  workspaces. Everyone else joins by invite and sees "Ask an admin to invite
  {email}." (`new_workspace` returns `403 account_creation_restricted`).
- Set it to `false` for open creation.
- Who may sign up at all is `KORTIX_SIGNUP_MODE` (open, invite, closed;
  `self_host_signup_policy`).

**First owner.** `POST /v1/setup/bootstrap-owner` now creates the owner's
account explicitly. The owner then sees "Create a workspace". PR 1 verifies
that a platform-admin email still counts as admin without an account whose id
equals the user id (`shared/platform-roles.ts:28-64` looked the user up through
that id).

## Kortix Capture

Capture is per account (`capture_workspaces` PK `account_id`), so it is per
workspace without change. Prod: 2 Capture accounts, 1 enabled, 0 without a
project, 1 with several projects.

- PR 1: Capture opens from Workspace settings. The desktop authorize page
  lists workspaces by name and icon; a person with 0 workspaces sees "Create
  or join a workspace first" (today it says no account has Capture on).
- `/capture/[accountId]` keeps working; its own account switcher goes later.
- A legacy multi-project account shares one Capture tenant across its
  workspace rows until the split; Capture stays with the account that keeps
  billing.
- `capture_workspaces` is renamed with the other "workspace" collisions
  later (no screen changes).

## Everything else

| Area | Behavior | When |
|---|---|---|
| CLI login | 0 workspaces: the device page offers "Create workspace", then approves. 2+: the device page asks which workspace the CLI key belongs to and sends `account_id` | PR 1 |
| Personal access keys, plan, usage, Git connections | move from `/settings` into Workspace settings; old `/settings/{tokens,plan,credits,connected}` links redirect there | PR 1 |
| Default model | "Set as default" writes the workspace (project) default. 114 accounts hold an account-wide default; it keeps applying as the fallback until the split | PR 1 |
| Transfer workspace | hidden: moving one workspace's project into another workspace would break 1 workspace = 1 project. Stays as the split's engine | PR 1 |
| Delete | deleting your last workspace keeps your login; "Delete my login" lives in personal settings and works with 0 workspaces (flow DEL-6) | PR 1 |
| SSO / SCIM | 1 identity provider per workspace (unique per account; Supabase provider ids are global). Prod: 0 SSO providers | unchanged |
| Slack / Teams | one Slack workspace can connect to several Kortix workspaces; the channel picker already asks when ambiguous | unchanged; picker labels later |
| Chrome extension | per person; with 0 workspaces it says "Create or join a workspace first". Prod: 0 connections | later |
| Connected computers | private machines stay personal (stored under the person's id as a namespace; 0 dangling rows in prod); shared machines belong to a workspace | unchanged |
| Notifications | inbox stays per person across workspaces; each row names its workspace | later |
| Admin console | one Workspaces list keyed by `project_id`, "has workspace" filter, legacy badge "N workspaces, shared billing" | later |
| White-label (Lumen) | its bootstrap provisions into the operator's account; it moves to `new_workspace: true` before the second-project `409` ships | later, with stage 9 |
| URLs and API names | `/workspaces/<id>`, `/v1/workspaces`, `kortix workspaces` (CLI done in PR 1) | later, mechanical |
