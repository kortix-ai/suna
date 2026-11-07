/**
 * Unified feature-flag registry.
 *
 * We ship fast and we ship a lot. Any surface — experimental, beta, or fully
 * stable — can ship dark behind a per-project flag and be turned on from
 * Settings → Feature flags. "Experimental" is a stability badge on a flag,
 * not the system's name.
 *
 * Each flag has two gates:
 *   • available  — does the PLATFORM support it at all (operator env)? When a
 *                  flag is unavailable, the per-project toggle is hidden and
 *                  the surface stays dark no matter what a project has chosen.
 *   • enabled    — the EFFECTIVE per-project state: the project's explicit
 *                  choice (projects.metadata.experimental[key]) over the
 *                  operator default. `enabled` always implies `available`.
 *
 * Per-project state is DB-only (projects.metadata) — never in kortix.yaml.
 * The `experimental` metadata key is a stable storage detail; do not rename it.
 *
 * To add a flag, the key goes in SIX places. Typecheck forces only one of them
 * (the SDK union), so do not rely on a clean build:
 *
 *   1. `FeatureFlagMapSchema` — packages/api-contract/src/index.ts
 *   2. TWO sites in packages/api-contract/src/__tests__/schemas.test.ts: a
 *      project fixture, and a hand-written copy of the key list
 *   3. The `FeatureFlagKey` union AND the `FEATURE_FLAG_KEYS` array —
 *      packages/sdk/.../projects-client/projects.ts. Only the union is
 *      typechecked; a missing array entry compiles fine.
 *   4. Another hand-written copy in that package's projects.test.ts
 *   5. An entry below, DECLARING its enforcement mode
 *   6. One `useFeatureFlag` call + one map entry in
 *      packages/ui/src/internal/lib/use-project-feature-flags.ts (and move the trailing
 *      `isLoading:` to the newly-last hook)
 *
 * Then gate its routes with `requireFeatureFlag` (enforcement: 'routes'), or
 * its runtime behavior on `resolveFeatureFlag` (enforcement: 'behavioral').
 *
 * ## A flag gates EVERY surface
 *
 * Off, nothing of the feature exists in the project except the fact that its
 * flag is off. On, everything shows and loads. Each surface has one mechanism:
 *
 *   • API — `requireFeatureFlag` on its routes (403 `feature_disabled`).
 *   • Session box — the API lists the enabled flags in KORTIX_FEATURE_FLAGS
 *     (projects/lib/feature-flag-env.ts). Boot-only; a change reaches the next
 *     new box.
 *   • Managed skill — put the feature's agent docs in their own skill under
 *     packages/starter/templates/managed/skills, with `metadata:
 *     kortix-feature-flag: <key>` in its frontmatter. kortixd withholds it from a
 *     box without the flag; the project's skill list hides it. Never describe a
 *     flagged feature inside an unflagged skill (kortix-system, kortix-cli).
 *   • CLI command — `featureFlag: '<key>'` on its apps/cli/src/command-table.ts
 *     entry: listed and run only where the flag is known on — the box's list,
 *     or outside a box the linked project's flags from the API. Never suggested
 *     for a typo. `kortix system-skills` follows the same rule for a skill.
 *   • IAM — `iamActions` on the entry: the account permission catalog leaves
 *     them out until a project of the account has the flag on.
 *   • Notification kind — the settings screens drop a row the preferences
 *     API lists in `hidden_kinds` (empty today: no kind is behind a flag).
 *     Fill it from the flag in notifications/routes.ts while the kind cannot
 *     reach the person.
 *   • Web — `useFeatureFlag` hides every entry point (sidebar row, More menu,
 *     palette via `requiresFlag`, permission group via `featureFlag` in
 *     agent-editor-catalog.ts); a page a deep link still reaches renders
 *     `FeatureGateScreen` and loads no data. Public docs describe a feature
 *     once it is on by default; until then its reference lives in its skill.
 *
 * FOUR separate tests guard those six sites, each in its own package, so each
 * one fails only when that package's suite runs — they surface one CI round at
 * a time. `unit-feature-flag-drift.test.ts` compares contract <-> SDK <->
 * registry and catches 1/3/5 only. List every holder before you start:
 *
 *   rg -l "reminders" --glob '!node_modules' . | xargs rg -l "voice_call"
 *
 * The UI renders straight from {@link buildFeatureFlagCatalog}, so a new entry
 * lights up in Settings automatically. `unit-feature-flags.test.ts` pins the
 * catalog to the contract key list and requires every entry to declare its
 * enforcement.
 *
 * ## Hidden flags (`catalogHidden`)
 *
 * A flag that has become THE behavior is no longer a choice we present, but it
 * is not yet safe to delete: support still needs one lever to put a single
 * project back on the old behavior while that project migrates.
 * `catalogHidden: true` is exactly that state — RESOLVABLE but UNADVERTISED:
 *
 *   • `resolveFeatureFlag` / `resolveFeatureFlags` — UNCHANGED. The platform
 *     default still applies and an explicit project override still wins.
 *   • `buildFeatureFlagCatalog` — OMITS the entry while it is off, so
 *     Settings → Feature flags never offers it. While it is ON the catalog
 *     lists it with `operator_only: true`, so people and agents
 *     (`kortix projects features`) see it, read-only.
 *   • Writes — `PATCH /projects/:id/features` accepts the key only from a
 *     platform operator (403 `feature_operator_only` otherwise). The operator
 *     route is `PUT /v1/admin/api/projects/:id/features`. That is the support
 *     lever, and it is the whole reason this is not `available: () => false`
 *     (which would force the flag OFF for every project — the opposite of
 *     what a hidden default means).
 *
 * A hidden flag is a DATED state, not a parking spot: hide it in the release
 * that makes it the default, delete it in the next one. The comment on the
 * entry names the release and the spec section that ends it.
 *
 * The same state also serves INTERNAL-ONLY surfaces (`workspace_volume`):
 * not offered in Settings, enabled per project by a
 * Kortix operator on request. Their 403 says "contact Kortix" instead of
 * naming a toggle the caller cannot see (gate.ts).
 */
import { config } from '../config';
import { platinumUsRegion } from '../shared/platinum-region';
import type { FeatureFlagKey, FeatureFlagStability } from '@kortix/api-contract';

export type { FeatureFlagKey, FeatureFlagStability } from '@kortix/api-contract';

/**
 * How the flag is actually enforced server-side. This is a declaration the
 * tests read — it makes "the switch does nothing on the server" an explicit,
 * reviewed decision instead of silent drift.
 *
 *  • 'routes'     — HTTP surface rejects with 403 `feature_disabled` when off
 *                   (via `requireFeatureFlag`).
 *  • 'behavioral' — no dedicated routes; the flag changes what the platform
 *                   does (connector materialization, env injection, agent
 *                   list). Off ⇒ the behavior does not occur.
 *  • 'ui-only'    — the server deliberately does NOT enforce; the flag only
 *                   hides client surface. Requires `enforcementNote` naming
 *                   the decision. Use sparingly.
 */
export type FeatureFlagEnforcement = 'routes' | 'behavioral' | 'ui-only';

export interface FeatureFlagDef {
  key: FeatureFlagKey;
  /** Short human label (Title Case). */
  name: string;
  /** One sentence: what it does and what to expect. */
  description: string;
  stability: FeatureFlagStability;
  /** Work in progress: not recommended yet. The clients mark the row (Marko, 2026-10-27). */
  wip?: boolean;
  /** Platform support gate (operator env). Hidden in UI when false. */
  available: () => boolean;
  /** Per-project default when the project hasn't made an explicit choice. */
  platformDefault: () => boolean;
  enforcement: FeatureFlagEnforcement;
  /** Mandatory for 'ui-only': why the server does not enforce. */
  enforcementNote?: string;
  /**
   * Not offered as a toggle: the catalog ({@link buildFeatureFlagCatalog})
   * lists it only while it is on, marked `operator_only`, and only a platform
   * operator can write it. Resolution is untouched — see "Hidden flags" in
   * this file's header.
   */
  catalogHidden?: true;
  /**
   * IAM actions that exist only with this flag. The account permission catalog
   * (`GET /accounts/:id/iam/permissions`) leaves them out until a project of the
   * account has the flag on ({@link hiddenIamActions}).
   */
  iamActions?: readonly string[];
}

/**
 * The registry. Order here is the order shown in Settings → Feature flags.
 *
 * Computers need no flag: a paired machine is an account on the project's
 * `computer` connector. The platform-wide `TUNNEL_ENABLED` env is the only gate.
 */
const FLAGS: readonly FeatureFlagDef[] = [
  {
    key: 'marketplace',
    name: 'Marketplace',
    description:
      'Browse and 1-click install skills from a marketplace of community & vendor registries (any SKILL.md repo). Sources, updates, and team scopes are still in flux.',
    stability: 'beta',
    available: () => true,
    // On by default for every project — no longer gated behind an opt-in toggle.
    platformDefault: () => true,
    enforcement: 'routes',
  },
  // `connectors_api_discover` graduated (2026-10-24) with `connectors_v2`:
  // integrations.sh is part of the one Kortix catalog every project browses.
  // A stored override is inert.
  // `agentmail_email` graduated (2026-10-24): every project can connect an
  // email inbox. Turning it on never provisioned an inbox (only an explicit
  // connect does), so graduating creates nothing. A stored override is inert.
  // `llm_gateway` graduated (2026-10-20): the LLM gateway is the only model
  // path for every project. No flag, no native OpenCode provider mode, no
  // operator lever. A stored `experimental.llm_gateway` override is inert.
  // `meta_agent` removed (2026-11-02): My Kortix follows kortix.yaml
  // `builtin_agents.my_kortix` alone and is on when the key is not set
  // (projects/lib/my-kortix-agent.ts). The flag defaulted off until 2026-10-24,
  // so projects that saved Settings before then stored `false` and lost My
  // Kortix after it became the default. A stored `experimental.meta_agent`
  // override is inert; the API still sends `true` to older clients.
  // `apps` graduated (2026-10-14, spec §28): Apps is generally available —
  // every project can create and deploy Apps and there is no flag, no row and
  // no operator lever. A stored `experimental.apps` override is inert.
  // `monitors` (the per-project monitor box) was removed: an App with a
  // schedule or `type: app` trigger replaces it. A stored
  // `experimental.monitors` override is inert.
  // `warm_sessions` removed (2026-11-03): a session boots fast enough on its
  // own, and 66 % of the pre-created sessions were never used. Clients no
  // longer pre-create a session; POST /sessions/warm and /sessions/warm/claim
  // answer 410 (routes/retired.ts). A stored `experimental.warm_sessions`
  // override is inert; the API still sends `false` to older clients.
  {
    key: 'reminders',
    name: 'Loops',
    description:
      'Let agents and people schedule a Loop on a session — "in 24 hours, check whether the vendor replied", once or on repeat. Each fire re-prompts that session. Adds loops to the Triggers list, the session loop chip, and `kortix loop` in the CLI.',
    stability: 'beta',
    available: () => true,
    // On by default (2026-10-19): goals wake on a heartbeat reminder (kortix-goals).
    platformDefault: () => true,
    // Routes 403 `feature_disabled`; the scheduler also skips reminder rows of
    // a project with the flag off (trigger-execution-store claimDueScheduleSlots).
    enforcement: 'routes',
  },
  {
    key: 'secrets_egress',
    name: 'Network-Enforced Secrets',
    description:
      'Let a secret be enforced at the network instead of loaded into the sandbox: the sandbox holds a handle and Kortix substitutes the real value only on requests to approved hosts. Off ⇒ every secret loads into the sandbox environment and the "Enforce at the network" option is hidden.',
    stability: 'experimental',
    available: () => true,
    // On by default (Marko, 2026-09-03). The OPTION is available; a new secret
    // still defaults to an environment variable — enforcing at the network is
    // a per-secret choice. A project that turns the flag off hides the option
    // and the write routes refuse to move a secret into egress delivery.
    platformDefault: () => true,
    enforcement: 'behavioral',
    enforcementNote:
      'No dedicated routes. The secret write paths (POST /secrets in ' +
      'projects/routes/secrets.ts, PUT /secrets/:id/strategy in ' +
      'projects/routes/secret-delivery.ts) reject a request that ' +
      'moves a secret INTO egress delivery when the flag is off. A secret that ' +
      'is already egress keeps serving and stays editable, so turning the flag ' +
      'off never strands an existing enforced secret.',
  },
  {
    key: 'pooled_provider_secrets',
    name: 'Pooled Provider Secrets',
    description: 'Members connect their own ChatGPT and Claude subscriptions and provider keys, share them when needed, and choose which ones each session uses.',
    stability: 'experimental',
    available: () => true,
    // On by default since 2026-10-31: every project gets private-by-default
    // provider accounts. A project that turned it off keeps it off.
    platformDefault: () => true,
    enforcement: 'behavioral',
    enforcementNote: 'Session selection and provider credential resolution reject or ignore resource secrets while disabled.',
  },
  // `pi_harness` graduated (2026-10-23): every new session runs pi; OpenCode is
  // sunset (kortixd has no OpenCode harness since 2026-10-30). No flag, no
  // operator lever, no manifest `runtime:` choice. A stored
  // `experimental.pi_harness` override is inert.
  // `genui` graduated (2026-10-24): generative UI is always on. Every session
  // lists the kortix-genui system skill; no flag, no kill switch. A stored
  // `experimental.genui` override is inert.
  {
    key: 'us_region',
    name: 'US Region',
    description:
      "Place this workspace's Files and newly provisioned Platinum sandboxes in the configured US region instead of the provider's home region. Files stay in the region where they were created, and every new sandbox runs where the workspace's Files live, so changing this setting after the Files exist does not move them or their sessions. Existing sandboxes keep their region, including on restart. This changes compute and Files placement, not API, database, or archive residency. A new sandbox image is copied to the region before sessions use it.",
    stability: 'experimental',
    // Two operator gates: Platinum must be the configured provider, and the
    // environment must name the region (KORTIX_PLATINUM_US_REGION), which is
    // also what says the Platinum org holds a grant for it. Unset ⇒ hidden.
    available: () => Boolean(config.PLATINUM_API_KEY) && platinumUsRegion() !== null,
    // Off unless the operator sets KORTIX_PLATINUM_US_REGION_DEFAULT (dev does).
    platformDefault: () => config.KORTIX_PLATINUM_US_REGION_DEFAULT === true,
    // Read when a project's drive is created (drives/service.ts
    // ensureProjectDrive) and at provisioning (platform/services/sandbox-region.ts
    // resolveSessionPlacement), sent as `region` on the Platinum create. Off ⇒
    // the home region, unless the project's Files already live in another.
    enforcement: 'behavioral',
  },
  {
    key: 'event_triggers',
    name: 'Composio event triggers',
    description:
      'Start an agent when something happens in a connected app: a new email, a pull request, a calendar event. ' +
      'Events come from Composio, and Kortix also checks your connected apps itself.',
    stability: 'beta',
    // Always offered: on a deployment with no event source configured, the
    // triggers themselves say so (status `error` naming COMPOSIO_API_KEY).
    available: () => true,
    // Per-project opt-in on every environment (Marko, 2026-10-24: keep it behind the flag).
    platformDefault: () => false,
    enforcement: 'routes',
    enforcementNote:
      'ROUTES: GET /triggers/event-types, GET /triggers/event-apps, and POST|PATCH /triggers ' +
      'with `type: event` answer 403 `feature_disabled` when off (projects/routes/triggers.ts). ' +
      'BEHAVIORAL: a `type: event` trigger in kortix.yaml is not subscribed and reads status ' +
      '`error` (trigger-events/subscriptions.ts); turning the flag off releases every event ' +
      'subscription of the project and turning it on reconciles them (feature-flags/toggle-effects.ts); ' +
      'deliverEvents never fires for a project with the flag off (trigger-events/deliver.ts).',
  },
  // `notification_center` graduated (2026-11-06: "get rid of the feature flag,
  // they should be available by default"): every project writes inbox rows and
  // sends Web Push and mobile push to the people a session concerns, follows
  // sessions, and raises trigger, goal, reminder, share and permission alerts.
  // Email is opt-in per kind (@kortix/shared/notification-kinds). The
  // creator-only Expo push of a flag-off project is deleted. A stored
  // `experimental.notification_center` override is inert. The project detail
  // still sends the key as `true` for older SDKs, hosts, CLIs and mobile builds.
  // `volumes` and `drives` graduated (2026-11-02, Marko: "rm the feature flag
  // for volumes, make them default & always enabled"): every project has a
  // Drive wherever the platform stores one (Platinum configured,
  // drives/volumes.ts driveStorageAvailable). A stored `experimental.volumes`
  // or `experimental.drives` override is inert. The project detail still sends
  // both keys, equal to that availability, for older SDKs, hosts and CLIs.
  {
    key: 'goals',
    name: 'Goals',
    description:
      'Give an agent an objective and it owns the outcome until an independent check confirms it, for days or weeks: it plans, works, waits, chases people for what only they can give, and keeps its state in a Goals folder in the Drive. Needs Loops on (flag key `reminders`).',
    stability: 'beta',
    // Work in progress (Marko, 2026-11-01): Settings marks the row "Not
    // recommended yet" until Goals v1 is finished.
    wip: true,
    // A goal keeps its state in Files, and every drive is a Platinum volume.
    available: () => Boolean(config.PLATINUM_API_KEY),
    // Off by default; a project turns it on (Marko, 2026-10-28).
    platformDefault: () => false,
    enforcement: 'routes',
    enforcementNote:
      'Mixed, and every part is enforced on the server. ROUTES: every /v1/projects/:id/goals* route answers 403 ' +
      '`feature_disabled` when off (projects/routes/goals.ts). BEHAVIORAL: the goal admission gate ' +
      '(projects/goals/admission.ts, called from lib/trigger-fire.ts fireSessionReminder) refuses every heartbeat ' +
      'fire and every event wake of a goal while the flag is off: no turn runs, the goal is blocked `flag_off` and ' +
      'its heartbeat is switched off; a person resumes it after the flag is back on. A merged change request wakes ' +
      'no goal (projects/lib/goal-wake.ts). BOX: off, a session box has no kortix-goals skill and its CLI hides ' +
      '`kortix goals` (KORTIX_FEATURE_FLAGS → kortixd). The project_goals rows and the Goals folders in Files stay.',
  },
  // `artifacts` graduated (2026-11-06): every project has Artifacts wherever
  // the platform stores a Drive (an Artifact is a path in it). The routes
  // answer 403 `feature_disabled` only on a Kortix without a Drive
  // (projects/lib/artifact-access.ts). A stored `experimental.artifacts`
  // override is inert; the serializer sends the Drive availability for older
  // SDKs, hosts and CLIs.
  // `artifact_comments` removed (2026-11-06): comments, live presence, doc
  // co-editing and the activity feed left the product; their routes answer
  // 410 (routes/retired.ts). A stored `experimental.artifact_comments` override
  // is inert; the serializer sends `false` to older clients.
  {
    key: 'email_channel',
    name: 'Email channel',
    description:
      'Give the agent an email inbox on Resend: inbound mail starts and continues sessions, and the agent reads, replies and sends from the inbox. Bring your own Resend API key and domain.',
    stability: 'experimental',
    available: () => true,
    platformDefault: () => false,
    enforcement: 'routes',
    enforcementNote:
      'ROUTES: …/channels/email/connect, /domains*, PATCH …/email/installation and an email `POST /connectors` answer 403 `feature_disabled`; ' +
      'GET …/email/installation answers null and …/email/mode `enabled: false`; the Resend webhook ignores the project\'s inboxes; ' +
      'channel materialize and sync drop the email connector; the catalog hides native:email.',
  },
  // `session_log` graduated (2026-10-22, P8.2): the session log is every session's
  // saved history and the v1 transcript mirror is no longer read. No flag and no
  // operator lever. A stored `experimental.session_log` override is inert.
  // `session_log_restore` graduated (2026-11-05): every box reads the session-log
  // manifest at boot and restores its native store when it is missing or behind
  // (kortixd harness/shared/session-log-boot.ts). The only off switch is the
  // deployment's SESSION_LOG_RESTORE_ENABLED (the restore answers 503). A stored
  // `experimental.session_log_restore` override is inert; the serializer keeps
  // sending `true` for older SDKs and hosts.
  // `connectors_v2` graduated (2026-10-24): the Kortix catalog (MCP apps,
  // integrations.sh, Composio), Telegram as a channel connector, the Kortix
  // app-event source (under `event_triggers`) and no seeded empty project
  // account are the only connectors path. A stored override is inert; the
  // serializer keeps sending `true` for older clients.
  {
    key: 'chat',
    name: 'Spaces',
    description:
      "Spaces with Kortix, the way Slack works: every message is a thread, Kortix's newest reply shows under it, Kortix can start threads, and you share spaces with people. Replaces the session list in the sidebar.",
    stability: 'experimental',
    wip: true,
    available: () => true,
    platformDefault: () => false,
    enforcement: 'routes',
    enforcementNote:
      'Off ⇒ every /projects/:id/spaces route and POST /projects/:id/chat/threads answer 403 feature_disabled (projects/routes/project-spaces.ts, projects/routes/chat-threads.ts); ' +
      'session create/list ignore space_id. On: the person\'s DM with My Kortix is their chat; each My Kortix thread in it gets the board of the other threads at turn start ' +
      '(projects/lib/chat-threads.ts). Turning it on creates #general and files every session without a space into it (feature-flags/toggle-effects.ts). ' +
      'THREAD FILES (memory/thread-files.ts): every session of a space thread (workers too) mounts the space\'s Files folder read-write ' +
      '(drives/service.ts sessionSpaceFolder; a private channel\'s as before). The conversation is never copied into files: ' +
      'each turn\'s system text names the thread\'s root session (read with `kortix sessions log <id>`), the thread folder ' +
      '(<space folder>/threads/<slug>-<id>/ with work/ and results/) and context.md. ' +
      'STORED OVERRIDE: experimental.chat, else the legacy experimental.project_channels, else experimental.infinichat (explicitOverride). ' +
      'BOX: absent from KORTIX_FEATURE_FLAGS (projects/lib/feature-flag-env.ts), so kortixd withholds the kortix-channel-memory skill; a change reaches the next new box. ' +
      'WEB: a Chat row (/projects/:id/chat) and the spaces list replace New session and the session list; /projects/:id/chat renders FeatureGateScreen while off. ' +
      'PRIVATE CHANNELS (shared/space-access.ts) are enforced whatever this flag says, and created only with KORTIX_PRIVATE_CHANNELS_ENABLED. ' +
      'Revocation windows after a removal or a conversion: REST ≤ 10 s on another replica (access memo; busted at once on the serving one), ' +
      'proxy ≤ 10 s more (verdict cache; cleared on the serving replica), /events SSE, proxied SSE and proxied WebSockets ≤ 60 s (re-check; WebSockets of the serving replica at once). ' +
      'A channel created private reads as public on another replica for ≤ 10 s. ' +
      'Accepted limits: a private thread\'s git branch is readable like any branch, and agent config, skills, MCP tools and network egress are not private.',
  },
  {
    key: 'shared_drives',
    name: 'Shared drives',
    description:
      'Drives the whole team can use: an admin makes a Drive and adds agents to it. Every session of those agents mounts it, and everyone who may use one of them can open it. Off, every person has only My files.',
    stability: 'experimental',
    wip: true,
    available: () => true,
    // On by default (Marko, 2026-11-05): teams share Drives out of the box; a project can still turn it off.
    platformDefault: () => true,
    enforcement: 'routes',
    enforcementNote:
      'PUT /v1/drives/:driveId/access answers 403 feature_disabled while off. Off, driveSubjectFor gives a person no agent reach (agentIds empty) and ' +
      'planSessionDrives mounts no folder granted to an agent: a session mounts only its person\'s own folder (and a private channel thread its channel folder). ' +
      'Grants made while on stay stored and count again when it is turned on; a change reaches running sessions at their next mount enforcement or boot. ' +
      'WEB: the Drive tree shows only My files while off (no Drives section, no All files, no Share).',
  },
  {
    key: 'workspace_volume',
    // The key keeps its name: it is in the SDK's FeatureFlagKey and stored on projects.
    name: 'Stateless sandboxes',
    description:
      "Every new Platinum session keeps only /workspace, on its own Platinum volume, so the sandbox is disposable: one stopped for an hour (KORTIX_SANDBOX_IDLE_DELETE_MINUTES) is deleted, and the next open boots a new sandbox on the same files and conversation. Programs that ran in the old sandbox are not running, and the agent is told so. Not a Settings toggle: Kortix enables it per workspace.",
    stability: 'experimental',
    // Every workspace volume is a Platinum volume.
    available: () => Boolean(config.PLATINUM_API_KEY),
    platformDefault: () => false,
    // Internal-only: stateless sandboxes roll out project by project. A Kortix
    // operator sets it (PUT /v1/admin/api/projects/:id/features).
    catalogHidden: true,
    enforcement: 'behavioral',
    enforcementNote:
      'BEHAVIORAL only. Read once per session, at POST /sessions (platform/services/workspace-volume.ts): on, a ' +
      'Platinum session is inserted with `metadata.workspace_volume` and every box it ever gets mounts volume ' +
      'kws-<session_id> at /workspace, in the region the volume was created in, with KORTIX_WORKSPACE_VOLUME=1 and ' +
      'the session-log restore on. Turning the flag off changes no session that has a volume; ' +
      'KORTIX_WORKSPACE_VOLUMES=off stops new volumes everywhere. A box stopped longer than ' +
      'KORTIX_SANDBOX_IDLE_DELETE_MINUTES (default 60) is deleted (projects/reaping/idle-volume-retire.ts). The ' +
      'volume is deleted with the session content: by the retention purge after the trash window ' +
      '(projects/session-log-purge.ts) or by account erasure.',
  },
  {
    key: 'session_groups',
    name: 'Session groups',
    description:
      "Group the sidebar's sessions into named folders that everyone in the workspace shares, for example one per store or client. Move a session into a group from its menu or by dragging it; reorder and collapse the groups.",
    stability: 'experimental',
    wip: true,
    available: () => true,
    platformDefault: () => false,
    enforcement: 'routes',
    enforcementNote:
      'ROUTES: every /projects/:id/session-groups route and PUT /projects/:id/sessions/:sid/group answer 403 ' +
      '`feature_disabled` while off (projects/routes/session-groups.ts). The session list ignores `group` while off, ' +
      "so the sidebar lists every session again. Turning it off deletes nothing: the groups and each session's " +
      '`group_id` stay and come back when it is turned on. WEB: no group sections, no New group and no Move to group.',
  },
  {
    key: 'chrome',
    name: 'Kortix in Chrome',
    description:
      "Let a session drive your own Chrome, with your logins, through the Kortix in Chrome extension: it opens its tabs in a group named after the session, and you can take over or stop it at any time.",
    stability: 'experimental',
    // Off on staging and prod until the Chrome Web Store listing is public.
    available: () => config.KORTIX_CHROME_ENABLED,
    platformDefault: () => true,
    enforcement: 'routes',
    enforcementNote:
      'ROUTES: POST /v1/chrome/attach answers 403 `feature_disabled` when the calling session\'s project has it ' +
      'off (chrome/routes.ts); release stays open so a session can always let go. The browsers a person ' +
      'connected are account-level and gated only by KORTIX_CHROME_ENABLED (404 when off). BOX: off, the ' +
      'session has no kortix-chrome skill and its CLI hides and refuses `kortix chrome` (KORTIX_FEATURE_FLAGS). ' +
      'WEB: no sidebar row, no Chrome card in Apps and extensions, no Settings page.',
  },
  {
    key: 'agent_teams',
    name: 'Agent teams',
    description:
      'A lead session starts named teammates that share one task list: each teammate claims a task, works it in its own session and tells the lead when it is done. The lead and the person see every teammate and its tasks. Messages between sessions (`send_message`) work without this flag.',
    stability: 'experimental',
    wip: true,
    available: () => true,
    platformDefault: () => false,
    enforcement: 'routes',
    enforcementNote:
      'Off ⇒ a project has no team task list. ROUTES: GET/POST /projects/:id/sessions/:lead/tasks and ' +
      'PATCH/DELETE /projects/:id/sessions/:lead/tasks/:seq answer 403 `feature_disabled` (projects/routes/team-tasks.ts). ' +
      'BOX: absent from KORTIX_FEATURE_FLAGS (projects/lib/feature-flag-env.ts), so kortixd registers no task_* tool; ' +
      'a change reaches the next new box. Cross-session messages (`send_message`, `list_agents`, the peer-message ' +
      'routes) do not read this flag. The session list `team_lead` filter and the session row fields stay on: ' +
      'without teammates they return nothing new.',
  },
  {
    key: 'voice_call',
    name: 'Voice calls',
    description:
      'Call an agent from its page (Customize → Agents) and talk it through: a call is a session of its own on that agent, which hears you, answers in a voice and sees a screen you share; the conversation is that session\'s chat.',
    stability: 'experimental',
    wip: true,
    available: () => true,
    platformDefault: () => false,
    enforcement: 'behavioral',
    enforcementNote:
      'Off ⇒ nothing of the voice loads. BOX: absent from KORTIX_FEATURE_FLAGS (projects/lib/feature-flag-env.ts), so ' +
      'kortixd registers no voice extension and opens no voice port; a change reaches the next new box. WEB: no call ' +
      'button on the agent page. The gateway\'s audio routes are inference like chat: billed per use, not gated here.',
  },
  {
    key: 'chat_input',
    name: 'Spaces-ChatInput',
    description:
      'One control under the composer for who answers and how: pick the agent, and every other setting stays on Auto, inherited from that agent. Open a row to override the model, thinking effort, secrets, provider keys or sandbox for this session, and reset it to Auto in one click.',
    stability: 'experimental',
    wip: true,
    available: () => true,
    platformDefault: () => false,
    enforcement: 'behavioral',
    enforcementNote:
      'WEB ONLY, presentation. The composer (packages/ui/src/session/composer/ComposerCard.tsx) reads the flag and, on, ' +
      'renders one chat-input control in place of the agent, model and effort pickers and the session-overrides gear. ' +
      'It writes through the same handlers, so every prompt carries the same agent/model/variant/scope fields either way. ' +
      'No route, box env, skill, CLI command or IAM action changes: the API enforces each override exactly as it does with the flag off.',
  },
  {
    key: 'chat_front',
    name: 'Spaces-Router',
    description:
      'With Spaces on, the agent you chat with in a thread is a router: it does quick work itself (an answer, a short text, a look at the thread files) and hands longer work to the Space\'s agents. It writes back like a person, in short messages. An agent saves its full result as a file in the thread, and the router links that file instead of retyping it. Show work under a message opens the work behind it. Needs My Kortix on in kortix.yaml.',
    stability: 'experimental',
    wip: true,
    available: () => true,
    platformDefault: () => false,
    enforcement: 'behavioral',
    enforcementNote:
      'Off ⇒ every thread runs as before. API: on together with `chat`, a top-level My Kortix session created in a space ' +
      '(no parent, no fork, no session caller) gets the reserved runtime_context key `kortix.front` and the server-managed ' +
      'metadata `kortix_front` (projects/lib/front-thread.ts); a request body cannot set either. Only such a front may start ' +
      'a My Kortix worker, an exception to META_AGENT_RECURSION; a worker of any other project agent is a normal hand-off. ' +
      'BOX: a front keeps its agent\'s own tools for quick work plus `agent`, `send_message` and `task_stop` (harness/pi/front.ts); ' +
      'each `agent` call starts or continues one named background worker as an agent of the thread\'s space (the API sends ' +
      '`space_agents`; a spawn outside it is 400 AGENT_NOT_IN_SPACE), else the project\'s agents from `/detail`. A worker writes ' +
      'its full result to the thread\'s results/<name>-<n>.md and reports the path; the front links it. KORTIX_PI_CLOUD_SUBAGENTS_MAX_DEPTH is 3 so a worker keeps its own ' +
      'subagents (projects/lib/feature-flag-env.ts). Each worker prompt ends with a "Context files" block (the thread ' +
      'folder, the thread\'s session id to read with `kortix sessions log`, context.md, the worker\'s work/<name>/ folder) from the prompt body\'s ' +
      '`thread_files`, which only the API sets (memory/thread-files.ts, with `chat`). WEB: a front thread\'s "Open full ' +
      'session" opens its worker.',
  },
  {
    key: 'spaces_proactive',
    name: 'Spaces-Proactive',
    description:
      'With Spaces on, a space can watch itself: turn on Proactive in its details, and an agent reads what happens there (finished threads, questions left open, people who join) and writes in the chat only when it matters: a result worth sharing, a decision you need to make, or something overdue. It can also start a thread that does the work. Optional daily brief at 9:00.',
    stability: 'experimental',
    wip: true,
    available: () => true,
    platformDefault: () => false,
    enforcement: 'behavioral',
    enforcementNote:
      'Off ⇒ nothing is recorded and no watcher wakes. API: with `chat` and this flag on and a space\'s Proactive on ' +
      '(`project_space_watchers`, PUT /projects/:id/spaces/:spaceId/proactive), each finished turn of a top-level thread, ' +
      'an ask open over 2 h, and a person or agent joining write one row to `project_space_events` (projects/lib/space-watch/). ' +
      'The `space-watcher` job wakes the space\'s one watcher session (source `system:space-watcher`, private to the space\'s ' +
      'owner, not filed in the space) at most once per 10 min and 24 times a day, at once for an overdue ask. It mirrors the ' +
      'feed to events.md in the space folder. BOX: runtime_context `kortix.watcher` gives the watcher no tools ' +
      '(harness/pi/watcher.ts); its answer is one JSON decision that the API carries out at turn end through the space post ' +
      'path, in that space only, with the owner\'s rights. WEB: the Proactive and Daily brief rows in Space details.',
  },
];

const FLAG_BY_KEY: Record<FeatureFlagKey, FeatureFlagDef> = Object.fromEntries(
  FLAGS.map((f) => [f.key, f]),
) as Record<FeatureFlagKey, FeatureFlagDef>;

/** Registry order, for tests and iteration. Same members as the contract's
 *  FEATURE_FLAG_KEYS — unit-feature-flags.test.ts pins the equality. */
export const REGISTERED_FEATURE_FLAGS: readonly FeatureFlagDef[] = FLAGS;

export function isFeatureFlagKey(value: unknown): value is FeatureFlagKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FLAG_BY_KEY, value);
}

export function featureFlagDef(key: FeatureFlagKey): FeatureFlagDef {
  return FLAG_BY_KEY[key];
}

/** Read the per-project explicit override map from a project's metadata. */
function overridesOf(metadata: unknown): Record<string, unknown> {
  const meta = (metadata as Record<string, unknown> | null | undefined) ?? {};
  const exp = meta.experimental;
  return exp && typeof exp === 'object' ? (exp as Record<string, unknown>) : {};
}

/** Read a single project's explicit override for a flag. Non-boolean garbage
 *  in the stored map is treated as "no override". */
function explicitOverride(metadata: unknown, key: FeatureFlagKey): boolean | undefined {
  const map = overridesOf(metadata);
  // `chat` merged Channels (`project_channels`) and One chat (`infinichat`), 2026-11: a project keeps its old choice.
  const stored = key === 'chat' ? [map.chat, map.project_channels, map.infinichat] : [map[key]];
  return stored.find((value): value is boolean => typeof value === 'boolean');
}

/**
 * Effective enablement for one flag: the project's explicit choice over the
 * operator default, AND-gated by platform availability. An unavailable flag
 * is never enabled regardless of what a project chose.
 */
export function resolveFeatureFlag(metadata: unknown, key: FeatureFlagKey): boolean {
  const def = FLAG_BY_KEY[key];
  if (!def || !def.available()) return false;
  return explicitOverride(metadata, key) ?? def.platformDefault();
}

/**
 * The IAM actions of every flag that is off in all of `projectMetadatas` (an
 * account's projects): a permission catalog leaves them out.
 */
export function hiddenIamActions(projectMetadatas: readonly unknown[]): Set<string> {
  const hidden = new Set<string>();
  for (const flag of FLAGS) {
    if (!flag.iamActions || projectMetadatas.some((metadata) => resolveFeatureFlag(metadata, flag.key))) continue;
    for (const action of flag.iamActions) hidden.add(action);
  }
  return hidden;
}

/** Effective enablement for every flag, keyed by flag id. */
export function resolveFeatureFlags(metadata: unknown): Record<FeatureFlagKey, boolean> {
  return Object.fromEntries(
    FLAGS.map((f) => [f.key, resolveFeatureFlag(metadata, f.key)]),
  ) as Record<FeatureFlagKey, boolean>;
}

/** Serialized catalog entry for the client (drives Settings → Feature flags). */
export interface FeatureFlagView {
  key: FeatureFlagKey;
  name: string;
  description: string;
  stability: FeatureFlagStability;
  /** Platform supports it (operator env). When false the UI hides the toggle. */
  available: boolean;
  /** Effective per-project state (the switch position). */
  enabled: boolean;
  /** True when this project set an explicit choice (vs inheriting the default). */
  overridden: boolean;
  /** A `catalogHidden` flag: listed only while on, writable only by a platform operator. */
  operator_only: boolean;
  /** Work in progress: not recommended yet. */
  wip: boolean;
  /** Always `project`: no flag is set for a whole organization. Kept for the wire contract. */
  scope: 'project' | 'organization';
}

/**
 * Build the per-project catalog the clients render. Self-contained so the UI
 * never hard-codes the flag list — add to FLAGS and it appears.
 *
 * A `catalogHidden` entry appears only while it is on for this project, with
 * `operator_only: true`, so the clients show it read-only (see "Hidden
 * flags" in this file's header).
 */
export function buildFeatureFlagCatalog(metadata: unknown): FeatureFlagView[] {
  return FLAGS.flatMap((f) => {
    const enabled = resolveFeatureFlag(metadata, f.key);
    if (f.catalogHidden && !enabled) return [];
    return [{
      key: f.key,
      name: f.name,
      description: f.description,
      stability: f.stability,
      available: f.available(),
      enabled,
      overridden: explicitOverride(metadata, f.key) !== undefined,
      operator_only: isOperatorOnlyFeatureFlag(f.key),
      wip: f.wip === true,
      scope: 'project' as const,
    }];
  });
}

/** True when only a platform operator may write this flag. */
export function isOperatorOnlyFeatureFlag(key: FeatureFlagKey): boolean {
  return FLAG_BY_KEY[key]?.catalogHidden === true;
}
