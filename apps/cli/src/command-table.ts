export interface Command {
  name: string;
  args?: string;
  blurb: string;
}

export interface CommandSection {
  title: string;
  commands: readonly Command[];
}

export interface CommandTier {
  /** Band label above the tier's sections — the mental bucket, not a command. */
  label: string;
  sections: readonly CommandSection[];
}

// The help layout leads with the navigable hierarchy — Host › Account ›
// Project › Session, top-down, each with its `use` selection verb — then the
// feature bands that operate ON the linked project, then the CLI tool itself.
// You sign into a HOST, pick an ACCOUNT within it, pick a PROJECT within that,
// and open SESSIONS in the project. Order + membership here IS the layout.
export const TIERS: readonly CommandTier[] = [
  // Deliberately the first band on the screen. An agent in any harness that
  // holds only this binary and a token has to be able to find, unprompted, the
  // one command that teaches it the platform — so it leads, and its blurb says
  // what it is for in plain words rather than naming a noun ("skills") the
  // reader does not have a definition for yet.
  {
    label: 'Start here',
    sections: [
      {
        title: '',
        commands: [
          {
            name: 'system-skills',
            args: '[get <name>]',
            blurb: 'Learn how to drive Kortix — the platform docs, served live by your host',
          },
        ],
      },
    ],
  },
  {
    label: 'Where you are  (host › account › project › session)',
    sections: [
      {
        title: 'Sign in — per host',
        commands: [
          {
            name: 'hosts',
            args: '<subcommand>',
            blurb: 'Sign in + switch Kortix instances (login/logout/use/ls)',
          },
          { name: 'login', blurb: 'Sign in to the active host (shortcut for `hosts login`)' },
          { name: 'logout', blurb: 'Sign out of the active host (shortcut for `hosts logout`)' },
          { name: 'whoami', blurb: 'Inspect the active host — signed-in user + account' },
          {
            name: 'token',
            blurb: 'Inspect the active token context (project/session/agent grants)',
          },
          {
            name: 'self-host',
            args: '<subcommand>',
            blurb: 'Run your own Kortix instance from Docker images',
          },
        ],
      },
      {
        title: 'Account — within the host',
        commands: [
          {
            name: 'accounts',
            args: '<subcommand>',
            blurb: 'Switch the active account (use / ls / current)',
          },
          {
            name: 'members',
            args: '<subcommand>',
            blurb: 'Invite, remove and re-role the people in the account',
          },
          {
            name: 'groups',
            args: '<subcommand>',
            blurb: 'Group people so a role follows a team, not a person',
          },
          {
            name: 'tokens',
            args: '<subcommand>',
            blurb: 'Mint and revoke API keys + service accounts for this account',
          },
          {
            name: 'billing',
            args: '<subcommand>',
            blurb: 'Read plan, credits, transactions and per-project/session costs',
          },
        ],
      },
      {
        title: 'Project — within the account',
        commands: [
          {
            name: 'init',
            args: '[project-name]',
            blurb: 'Start a new Kortix project (a fresh standalone directory)',
          },
          {
            name: 'projects',
            args: '<subcommand>',
            blurb:
              'List, link, use, open, rename and configure projects (features, cli-tokens, upgrade)',
          },
        ],
      },
      {
        title: 'Session — within the project',
        commands: [
          {
            name: 'sessions',
            args: '<subcommand>',
            blurb: 'Run, share, queue, inspect, stop and delete project sessions',
          },
          {
            name: 'connect',
            args: '[session-id]',
            blurb: 'Attach the full OpenCode TUI to a session (picker when no id given)',
          },
          {
            name: 'chat',
            args: '[session-id]',
            blurb: "Talk to a session's agent (REPL or --prompt)",
          },
          {
            name: 'tui',
            args: '[options]',
            blurb: 'Experimental: the whole Kortix product as a terminal app (alias: kortix t)',
          },
        ],
      },
    ],
  },
  {
    label: 'The linked project',
    sections: [
      {
        title: 'Author & ship',
        commands: [
          { name: 'ship', blurb: 'Create the cloud project (first run) + push your code' },
          { name: 'validate', blurb: "Statically validate this project's kortix.yaml" },
          {
            name: 'doctor',
            args: '[--no-session]',
            blurb: 'End-to-end health check: auth, project, session, agent reply',
          },
          {
            name: 'schema',
            args: '[--version 1|2]',
            blurb: 'Print the canonical kortix.yaml/kortix.toml JSON Schema',
          },
        ],
      },
      {
        title: 'Agents & connectors',
        commands: [
          {
            name: 'agents',
            args: '<subcommand>',
            blurb: 'Default agent, per-agent model pin, scope and full configuration',
          },
          {
            name: 'models',
            args: '<subcommand>',
            blurb: 'Choose which models this project offers, and its default model',
          },
          {
            name: 'gateway',
            args: '<subcommand>',
            blurb: 'Configure the LLM gateway: routing, budgets, keys, usage, logs, test',
          },
          {
            name: 'connectors',
            args: '<subcommand>',
            blurb: 'Manage connectors agents call as tools (Pipedream/MCP/HTTP)',
          },
          {
            name: 'secrets',
            args: '<subcommand>',
            blurb: 'Manage project secrets (project-scoped)',
          },
          {
            name: 'providers',
            args: '<subcommand>',
            blurb: 'Connect LLM providers (API key or OAuth) for this project',
          },
          {
            name: 'env',
            args: '<subcommand>',
            blurb: 'Pull/push project secrets as a dotenv file',
          },
          {
            name: 'channels',
            args: '<subcommand>',
            blurb: 'Slack, Teams and Email channels, per-channel bindings',
          },
          {
            name: 'sandboxes',
            args: '<subcommand>',
            blurb: 'Manage sandbox images: templates, builds, health, provider pin',
          },
          {
            name: 'apps',
            args: '<subcommand>',
            blurb: 'Experimental: deploy serverless Apps with stable Kortix URLs',
          },
          {
            name: 'marketplace',
            args: '<subcommand>',
            blurb: 'Search, show, install, and inspect marketplace items',
          },
        ],
      },
      {
        title: 'Files, changes & triggers',
        commands: [
          {
            name: 'files',
            args: '<subcommand>',
            blurb: 'Browse repo files, commits, branches, diffs; download a zip',
          },
          { name: 'cr', args: '<subcommand>', blurb: 'Open, review, merge change requests' },
          {
            name: 'review',
            args: '<subcommand>',
            blurb: "The project's review inbox: approve, reject, request changes",
          },
          { name: 'triggers', args: '<subcommand>', blurb: 'List, fire, enable/disable triggers' },
        ],
      },
      {
        title: 'Access & permissions',
        commands: [
          {
            name: 'access',
            args: '<subcommand>',
            blurb: 'Grant, list and revoke role assignments (people, groups, agents)',
          },
          {
            name: 'roles',
            args: '<subcommand>',
            blurb: 'List system + custom roles and what each one permits',
          },
          {
            name: 'permissions',
            args: '<subcommand>',
            blurb: 'Browse the permission catalog roles are built from',
          },
          {
            name: 'audit',
            args: '<subcommand>',
            blurb: 'Read the account audit trail (who did what, when)',
          },
          {
            name: 'grants',
            args: '<subcommand>',
            blurb:
              "Assign agents to members or groups (they inherit the agent's skills/connectors/secrets)",
          },
        ],
      },
    ],
  },
  {
    label: 'CLI',
    sections: [
      {
        title: '',
        commands: [
          { name: 'update', blurb: 'Pull the latest CLI from kortix.com/install' },
          { name: 'uninstall', blurb: 'Remove the Kortix CLI from this machine' },
          { name: 'help', blurb: 'Show this help' },
          { name: 'version', blurb: 'Print the CLI version' },
        ],
      },
    ],
  },
];
