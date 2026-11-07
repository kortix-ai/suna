export interface Command {
  name: string;
  args?: string;
  blurb: string;
  /** The workspace feature flag the command exists behind (see feature-flags.ts). */
  featureFlag?: string;
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

// The help layout leads with the navigable hierarchy — Host › Workspace ›
// Session, top-down, each with its `use` selection verb — then the feature
// bands that operate ON the linked workspace, then the CLI tool itself. You
// sign into a HOST, pick a WORKSPACE within it, and open SESSIONS in the
// workspace. A workspace is one company's Kortix: its people, billing, agents
// and config repo (one account + its project on the wire). `projects` and
// `accounts` stay routed for scripts. Order + membership here IS the layout.
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
    label: 'Where you are  (host › workspace › session)',
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
          { name: 'whoami', blurb: 'Inspect the active host — signed-in user + workspace' },
          {
            name: 'token',
            blurb: 'Inspect the active token context (workspace/session/agent grants)',
          },
          {
            name: 'self-host',
            args: '<subcommand>',
            blurb: 'Run your own Kortix instance from Docker images',
          },
        ],
      },
      {
        title: 'Workspace — within the host',
        commands: [
          {
            name: 'workspaces',
            args: '<subcommand>',
            blurb: 'Create, list, switch, link, open, rename and configure workspaces',
          },
          {
            name: 'members',
            args: '<subcommand>',
            blurb: 'Invite, remove and re-role the people in the workspace',
          },
          {
            name: 'groups',
            args: '<subcommand>',
            blurb: 'Group people so a role follows a team, not a person',
          },
          {
            name: 'keys',
            args: '<subcommand>',
            blurb: 'API keys that act as you, an agent or a bot',
          },
          {
            name: 'tokens',
            args: '<subcommand>',
            blurb: 'Older key commands: personal keys, service accounts, connected apps',
          },
          {
            name: 'billing',
            args: '<subcommand>',
            blurb: 'Read plan, credits, transactions and per-session costs',
          },
          {
            name: 'init',
            args: '[name]',
            blurb: "Scaffold a workspace's config repo in a fresh directory",
          },
        ],
      },
      {
        title: 'Session — within the workspace',
        commands: [
          {
            name: 'sessions',
            args: '<subcommand>',
            blurb: 'Run, share, queue, inspect, stop and delete workspace sessions',
          },
          {
            name: 'chat',
            args: '[session-id]',
            blurb: "Talk to a session's agent (REPL or --prompt)",
          },
          {
            name: 'tasks',
            args: '[<lead>] <subcommand>',
            blurb: "An agent team's shared task list: ls, add, claim, done, update, rm",
            featureFlag: 'agent_teams',
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
    label: 'The linked workspace',
    sections: [
      {
        title: 'Author & ship',
        commands: [
          { name: 'ship', blurb: 'Create the cloud workspace (first run) + push your code' },
          { name: 'validate', blurb: "Statically validate this workspace's kortix.yaml" },
          {
            name: 'doctor',
            args: '[--no-session]',
            blurb: 'End-to-end health check: auth, workspace, session, agent reply',
          },
          { name: 'schema', args: '[--url]', blurb: 'Print the canonical kortix.yaml JSON Schema' },
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
            name: 'tools',
            args: '<subcommand>',
            blurb: "List the workspace's tools (ls); copy a Kortix tool to change it (eject)",
          },
          {
            name: 'models',
            args: '<subcommand>',
            blurb: 'Choose which models this workspace offers, and its default model',
          },
          {
            name: 'gateway',
            args: '<subcommand>',
            blurb: 'Configure the LLM gateway: routing, budgets, keys, usage, logs, test',
          },
          {
            name: 'connectors',
            args: '<subcommand>',
            blurb: 'Manage connectors agents call as tools (Composio/MCP/HTTP)',
          },
          {
            name: 'secrets',
            args: '<subcommand>',
            blurb: 'Manage workspace secrets',
          },
          {
            name: 'providers',
            args: '<subcommand>',
            blurb: 'Connect LLM providers (API key or OAuth) for this workspace',
          },
          {
            name: 'env',
            args: '<subcommand>',
            blurb: 'Pull/push workspace secrets as a dotenv file',
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
            blurb: 'Deploy Apps (sites and servers) with stable Kortix URLs',
          },
          {
            name: 'marketplace',
            args: '<subcommand>',
            blurb: 'Search, show, install, and uninstall workspace marketplace skills',
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
          {
            name: 'drive',
            args: '<subcommand>',
            blurb: "The workspace's Files: list, read, upload, move, delete, share folders",
          },
          {
            name: 'search',
            args: '<query>',
            blurb: "Search the workspace's Files by name and text, beyond your session's mounts",
          },
          { name: 'cr', args: '<subcommand>', blurb: 'Open, review, merge change requests' },
          {
            name: 'review',
            args: '<subcommand>',
            blurb: "The workspace's review inbox: approve, reject, request changes",
          },
          {
            name: 'triggers',
            args: '<subcommand>',
            blurb: 'kortix.yaml and runtime triggers: a source (schedule, webhook, event, App, CR merged) plus a target (agent or session)',
          },
          {
            name: 'loops',
            args: '<subcommand>',
            blurb: 'A schedule into one session — a loop, a trigger that wakes its session (kortix loop "…" --in 24h; alias: reminders)',
          },
          {
            name: 'chrome',
            args: '<subcommand>',
            blurb: "Drive the user's own Chrome from a session (use, release, ls, status)",
            featureFlag: 'chrome',
          },
          {
            name: 'goals',
            args: '<subcommand>',
            blurb: 'Work a goal through the Goals API until a verifier passes every criterion: transition, progress, verify, verdict, handover, check, ls, status',
            featureFlag: 'goals',
          },
          {
            name: 'artifacts',
            args: '<subcommand>',
            blurb: 'Share docs and pages: publish, ls, share, versions, pull',
          },
          {
            name: 'spaces',
            args: '<subcommand>',
            blurb: 'Post into a space and configure it for its person: post (main chat or a thread, @mentions), rename, describe, tabs, agents, members',
            featureFlag: 'chat',
          },
          {
            name: 'capture',
            args: '<subcommand>',
            blurb: 'Search the Capture timeline of the person you act for (search, timeline, frame)',
          },
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
            blurb: 'Read the workspace audit trail (who did what, when)',
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
          {
            name: 'feedback',
            args: '"<message>" [--kind bug|idea|friction]',
            blurb: 'File product feedback for the team (from a shell or an agent session)',
          },
          { name: 'update', blurb: 'Pull the latest CLI from kortix.com/install' },
          { name: 'uninstall', blurb: 'Remove the Kortix CLI from this machine' },
          { name: 'help', blurb: 'Show this help' },
          { name: 'version', blurb: 'Print the CLI version' },
        ],
      },
    ],
  },
];

/** The feature flag of a root command, or undefined for an unflagged one. */
export function commandFeatureFlag(name: string): string | undefined {
  for (const tier of TIERS) {
    for (const section of tier.sections) {
      const command = section.commands.find((c) => c.name === name);
      if (command) return command.featureFlag;
    }
  }
  return undefined;
}
