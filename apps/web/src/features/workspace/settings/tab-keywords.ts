import type { SettingsTab } from './settings-tabs';

/**
 * Search terms per pane, shared by the two things that search panes: the
 * rail's own search field (`filterRailGroups` in `rail.ts`) and the command
 * palette (`settings-palette-items.ts`).
 *
 * **They must be the same words in both places.** They were not: the palette
 * carried this table and the rail matched on `label` + `description` alone, so
 * typing "slack" in the palette found Channels and typing it in the Customize
 * rail — the field sitting directly above the Channels row — returned "Nothing
 * matches". This module exists so there is one answer to "what is this pane
 * called", not two.
 *
 * **The rule.** A word belongs on a tab only when it NAMES THAT TAB — a
 * synonym, an alias, or something the tab itself contains. A word that names a
 * DIFFERENT row's subject is a defect: it answers a query this row is the
 * wrong answer to. Ask "if a user typed this word, is this tab a correct
 * answer?" before adding one.
 *
 * **The `project customize` tail is gone.** Twelve bags used to end in it,
 * carried over verbatim from the old `Customize · X` registry entries, so
 * "customize" returned twelve settings tabs plus five navigation rows and
 * "project" returned twelve tabs that are not the Projects page. `customize`
 * survives on exactly one row here — `general`, the Workspace tab that
 * `proj-customize` used to open, back when Customize was a label on that tab —
 * so the legacy word still lands on the legacy destination and nowhere else.
 * `project` survives only inside `general`'s phrase "project settings", the
 * pane's own former name.
 *
 * Four further corrections rather than straight carry-overs:
 *
 *   - `snapshot` moved off `sandbox` (it was `proj-sandbox`'s keyword) onto
 *     `snapshots`, which is the tab that word names. Typing "snapshot" used
 *     to reach Sandbox templates and could not reach Snapshots at all.
 *   - `profile name email` moved off the workspace `general` tab (they were
 *     `pref-general`'s keywords, pointing at the wrong of the app's three
 *     Generals) onto `profile`.
 *   - `keys` left `preferences` (it meant keyboard keys; `keyboard hotkeys
 *     keybindings` already say that) because it is the subject word of the
 *     `api-keys` tab.
 *   - `sso` left `organization` and `log record` left `snapshots`: `identity`
 *     is the tab that configures SSO and `audit` is the tab that is a log.
 */
export const TAB_KEYWORDS: Record<SettingsTab, string> = {
  profile: 'profile name email avatar personal you account display',
  preferences:
    'preferences appearance theme color mode dark light wallpaper shader shaders background sounds audio volume notification sound effects mute shortcuts keyboard hotkeys keybindings',
  connected: 'connected accounts linked oauth google github identities social sign in providers',
  general:
    'general project settings workspace repository danger zone rename delete customize configure',
  members: 'members team access collaborators people invite',
  agents: 'agents agent subagents ai personas instructions prompt model access who does the work',
  skills: 'skills skill abilities workflows reusable instructions playbooks procedures',
  // No "apps" here: it is the subject word of the `apps` row, and a query for
  // it must not also return Connectors. Same rule as `snapshot`/`sandbox`.
  connectors:
    'connectors connector connections integrations tools mcp oauth openapi postman collections pipedream access computers devices',
  apps: 'apps deploy deployments serverless docker static hosting urls published interfaces',
  secrets: 'secrets env environment variables values',
  channels: 'channels slack email agent mail agentmail agentic mail inbox messaging notifications',
  repositories: 'git repository repositories provider github code storage clone proxy branch sync',
  schedules: 'schedules cron triggers timed recurring',
  webhooks: 'webhooks triggers http endpoint',
  models:
    'llm gateway providers models budgets logs api keys overview anthropic openai openrouter google groq xai',
  marketplace: 'marketplace store install templates agents skills browse community',
  review: 'review center inbox approvals change requests approve reject needs you',
  voice: 'voice call speak spoken conversation livekit bot name',
  sandbox: 'sandbox templates image runtime environment machine',
  snapshots: 'snapshots snapshot builds prepared machine image history',
  organization: 'organization org account company name sign in rules teams manage',
  billing:
    'billing payment credit card subscription manage wallet tier plan limits overview spend',
  usage: 'usage credits ledger transactions history purchases receipts spend consumption',
  groups: 'groups teams directory scim membership sets',
  roles: 'roles permissions access rbac policy custom role',
  identity: 'identity sso saml oidc scim login provider single sign on directory',
  audit: 'audit log logs events history trail compliance',
  'api-keys':
    'api keys tokens personal access pat cli command line authentication service account',
  experimental: 'experimental feature flags beta preview labs toggles',
  upgrades: 'upgrades upgrade migrate migration registry manifest one-off runner change request',
};

