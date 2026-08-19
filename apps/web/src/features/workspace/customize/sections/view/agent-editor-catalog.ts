/**
 * Field-space catalogs for the agent editor — pulled out of agent-editor.tsx
 * so the modal file stays focused on composition. Pure data, no React.
 */

export const AGENT_MODES = ['primary', 'subagent', 'all'] as const;
/** Display names — the raw values are lowercase manifest keys, and a Select
 *  trigger renders the value verbatim (no `capitalize` reaches it). */
export const AGENT_MODE_LABEL: Record<(typeof AGENT_MODES)[number], string> = {
  primary: 'Primary',
  subagent: 'Subagent',
  all: 'All',
};
export const AGENT_MODE_HELP: Record<(typeof AGENT_MODES)[number], string> = {
  primary: 'People pick it to start a session. Other agents cannot call it.',
  subagent: 'Other agents call it. It never shows in the session picker.',
  all: 'People can start it, and other agents can call it.',
};
export const THEME_COLORS = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
  'info',
] as const;
/**
 * What each theme colour looks like, for the swatch picker. The manifest stores
 * the NAME (`success`), not a hex — the runtime resolves it against the active
 * theme. These classes are a preview of that resolution, mapped onto the
 * `kortix-*` brand tokens so the picker shows colour instead of seven words.
 */
export const THEME_COLOR_SWATCH: Record<(typeof THEME_COLORS)[number], string> = {
  primary: 'bg-foreground',
  secondary: 'bg-muted-foreground',
  accent: 'bg-kortix-purple',
  success: 'bg-kortix-green',
  warning: 'bg-kortix-orange',
  error: 'bg-kortix-red',
  info: 'bg-kortix-blue',
};
export const WORKSPACE_MODES = ['runtime', 'read', 'branch'] as const;
/** Display names — see AGENT_MODE_LABEL. */
export const WORKSPACE_MODE_LABEL: Record<(typeof WORKSPACE_MODES)[number], string> = {
  runtime: 'Runtime',
  read: 'Read',
  branch: 'Branch',
};
export const WORKSPACE_MODE_HELP: Record<(typeof WORKSPACE_MODES)[number], string> = {
  runtime: 'Edits the live project files directly.',
  read: 'Reads the project files. Cannot change them.',
  branch: 'Works on its own branch. You review and merge the result.',
};
export const PERMISSION_ACTIONS = ['allow', 'ask', 'deny'] as const;
/** Display names — see AGENT_MODE_LABEL. */
export const PERMISSION_ACTION_LABEL: Record<(typeof PERMISSION_ACTIONS)[number], string> = {
  allow: 'Allow',
  ask: 'Ask',
  deny: 'Deny',
};

// Permission keys that accept the full rule form (bare action OR glob-map).
// `skill` is intentionally EXCLUDED — the Skills governance control below owns
// `permission.skill` (the compiler maps `skills:` onto it), so exposing it here
// too would give two controls fighting over one key.
export const PERMISSION_RULE_KEYS = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'lsp',
] as const;
// Permission keys that only ever take a bare action (no glob-map form upstream).
export const PERMISSION_ACTION_ONLY_KEYS = [
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'doom_loop',
] as const;

export const PERMISSION_RULE_GROUPS: {
  label: string;
  keys: (typeof PERMISSION_RULE_KEYS)[number][];
}[] = [
  { label: 'Files and search', keys: ['read', 'edit', 'glob', 'grep', 'list'] },
  { label: 'Commands and tools', keys: ['bash', 'task', 'external_directory', 'lsp'] },
];

/** The heading over the keys that take a bare action and never a path rule. */
export const PERMISSION_ACTION_ONLY_GROUP_LABEL = 'Everything else';

/**
 * What each permission key lets the agent DO, in plain words.
 *
 * The raw key (`external_directory`, `lsp`, `doom_loop`) is a manifest token
 * and stays visible in mono beside this — people grep for it and hand-edit the
 * YAML. But a settings row whose only text is `lsp` tells a reader nothing, so
 * the sentence leads and the token follows.
 */
export const PERMISSION_KEY_LABEL: Record<string, string> = {
  read: 'Read files',
  edit: 'Create and change files',
  glob: 'Find files by name',
  grep: 'Search inside files',
  list: 'List folders',
  bash: 'Run shell commands',
  task: 'Hand work to a subagent',
  external_directory: 'Reach outside the project',
  lsp: 'Use the language server',
  todowrite: 'Keep a todo list',
  question: 'Ask you a question mid-run',
  webfetch: 'Fetch a URL',
  websearch: 'Search the web',
  doom_loop: 'Break out of a failure loop',
};

export const PERMISSION_KEY_HELP: Record<string, string> = {
  read: 'Read file contents.',
  edit: 'Create or modify files.',
  glob: 'Find files by name pattern.',
  grep: 'Search file contents by pattern.',
  list: 'List directory contents.',
  bash: 'Run shell commands.',
  task: 'Launch a subagent to run a task.',
  external_directory: 'Access paths outside this project workspace.',
  lsp: 'Use language-server tooling — go-to-definition, diagnostics.',
  todowrite: "Maintain the session's todo list.",
  question: 'Ask the user a clarifying question mid-run.',
  webfetch: "Fetch a URL's contents.",
  websearch: 'Run a web search.',
  doom_loop: 'Auto-break a detected repeat-failure loop.',
};

/**
 * The grantable `kortix_cli` action catalog, grouped for the picker. MUST stay
 * in sync with `GRANTABLE_KORTIX_CLI_ACTIONS` in @kortix/manifest-schema (=
 * PROJECT_ACTIONS in apps/api iam/actions.ts — every project-scoped action,
 * including the manager-tier leaves project.delete / project.members.manage /
 * project.gateway.keys.manage, still reachable via a project's `manager`
 * role). Mirrored here (not imported) because the manifest-schema/api
 * packages aren't in the web bundle — same mirror discipline as
 * apps/web/src/lib/project-actions.ts. Kept in sync by
 * agent-editor.test.tsx's drift guard against the real
 * `GRANTABLE_KORTIX_CLI_ACTIONS` constant.
 *
 * Account-scoped admin actions (member.*, billing.*, token.*, project.create,
 * …) are ALSO absent — but that omission is a UX curation choice, not the
 * security boundary: every agent-session token is project-scoped, and
 * apps/api's IAM v2 engine refuses any account-scope action for a
 * project-bound token before an agent's grant is even consulted (see
 * `iam/engine-v2.ts`'s `computeTokenScope`).
 */
export const KORTIX_CLI_CATALOG: { group: string; actions: string[] }[] = [
  { group: 'Project', actions: ['project.read', 'project.write', 'project.delete'] },
  { group: 'Change requests', actions: ['project.cr.open', 'project.cr.merge'] },
  {
    group: 'Sessions',
    actions: [
      'project.session.read',
      'project.session.start',
      'project.session.stop',
      'project.session.bindings.write',
    ],
  },
  { group: 'Members', actions: ['project.members.read', 'project.members.manage'] },
  {
    group: 'Triggers',
    actions: [
      'project.trigger.read',
      'project.trigger.create',
      'project.trigger.update',
      'project.trigger.delete',
      'project.trigger.fire',
    ],
  },
  {
    group: 'LLM gateway',
    actions: [
      'project.gateway.logs.read',
      'project.gateway.spend.read',
      'project.gateway.budget.set',
      'project.gateway.keys.manage',
    ],
  },
  {
    group: 'Configuration',
    actions: [
      'project.agent.read',
      'project.agent.write',
      'project.skill.read',
      'project.skill.write',
      'project.command.read',
      'project.command.write',
      'project.file.read',
      'project.file.write',
      'project.customize.read',
      'project.customize.write',
    ],
  },
  {
    group: 'Git',
    actions: ['project.gitops.read', 'project.gitops.push', 'project.gitops.merge'],
  },
  { group: 'Secrets', actions: ['project.secret.read', 'project.secret.write'] },
  {
    group: 'Connectors',
    actions: [
      'project.connector.read',
      'project.connector.write',
      'project.connector.connections.manage',
    ],
  },
  {
    group: 'Apps',
    actions: ['project.app.read', 'project.app.write', 'project.app.deploy'],
  },
  {
    group: 'Review',
    actions: ['project.review.read', 'project.review.submit', 'project.review.act'],
  },
];
