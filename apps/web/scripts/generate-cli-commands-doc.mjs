// Rewrites the CLI command tables of the docs (the generated:cli-commands
// region) from apps/cli/src/command-table.ts, the table `kortix --help`
// prints. The sections, their order, the commands and their arguments come
// from the table. A command behind a feature flag that is off by default is
// left out, as `kortix --help` leaves it out. The run fails when the CLI has a
// command this file does not describe, or this file describes one the CLI
// does not list: a new command needs its row here.
//
//   bun apps/web/scripts/generate-cli-commands-doc.mjs [file]           # default apps/web/content/docs/index.mdx
//   bun apps/web/scripts/generate-cli-commands-doc.mjs [file] --check
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cell, code, onByDefault, repositoryRoot, runRegionGenerator } from './docs-generated-region.mjs';

const SCRIPT = 'apps/web/scripts/generate-cli-commands-doc.mjs';

/** In the table, never in the docs. */
const UNDOCUMENTED = {
  // Attaches the OpenCode TUI; a pi session has no `session.attach` and the command exits 1.
  connect: 'OpenCode only',
};

/** The usage cell, where the table's arguments name more than the docs describe. */
const USAGE = {
  schema: 'schema --version 3',
};

/** command → [what it does, where the docs explain it]. */
const COMMANDS = {
  'system-skills': ['Print the Kortix platform manual, served live by your host. `kortix skills` is the same command.', '[Use Kortix from your coding agent](#use-kortix-from-your-coding-agent)'],
  hosts: ['Add, switch, list and sign out of Kortix instances.', '[Hosts](#hosts)'],
  login: ['Sign in to the active host. Same as `kortix hosts login`.', '[Sign in to a host](#sign-in-to-a-host)'],
  logout: ['Sign out of the active host. Same as `kortix hosts logout`.', '[Hosts](#hosts)'],
  whoami: ['The host, the signed-in user and the active account.', '[Check who you are](#check-who-you-are)'],
  token: ['The token context: project, session, agent and grants.', '[Check who you are](#check-who-you-are)'],
  'self-host': ['Set up, start, update and stop your own Kortix instance from Docker images.', '[Self-hosting](/docs/#self-hosting)'],
  accounts: ['List and switch accounts.', '[Teams](/docs/#teams)'],
  members: ['Invite and remove people, and change their roles.', '[Teams](/docs/#teams)'],
  groups: ['Groups of people that share a role.', '[Teams](/docs/#teams)'],
  tokens: ['Personal access keys, service accounts and connected apps.', '[Security](/docs/#security)'],
  billing: ['The plan, credits, transactions, and costs per project and per session.', '[Billing](/docs/#billing)'],
  init: ['Create a project directory from the starter, with a `kortix_version: 3` `kortix.yaml`.', '[The everyday loop](#the-everyday-loop)'],
  projects: [
    'List, create, clone, link, use, rename and delete projects. Also feature flags (`features`), project CLI tokens (`cli-tokens`) and the upgrade to `kortix_version: 3` (`upgrade`).',
    '[Which project a command uses](#which-project-a-command-uses)',
  ],
  sessions: ['Start, talk to, follow, stop and delete sessions.', '[Session commands](#session-commands)'],
  chat: ["Talk to a session's agent: a line chat, or one prompt with `-p`. Same as `kortix sessions chat`.", '[Session commands](#session-commands)'],
  tui: ['The whole product as a terminal app. `kortix t` and `kortixt` start it too. Experimental.', '[Everywhere](/docs/#everywhere)'],
  ship: ['Validate, commit and push the current branch. A folder with no link and no default project gets a new project. `kortix deploy` is the same command.', '[Commit and push](/docs/#commit-and-push)'],
  validate: ['Check `kortix.yaml` and the sandbox template Dockerfiles.', '[Check and validate](#check-and-validate)'],
  migrate: ['Convert the project manifest to `kortix_version: 3`. It prints the plan; `--write` applies it.', '[Migrate to v3](/docs/#migrate-to-v3)'],
  doctor: ['Check the login and the project, then start a throwaway session and wait for an agent reply.', '[Check and validate](#check-and-validate)'],
  schema: ['Print the `kortix.yaml` JSON Schema.', '[Check and validate](#check-and-validate)'],
  agents: ['The default agent, model pins, scope and the full agent config.', '[Agents](/docs/#agents)'],
  tools: ['List the tools sessions get; `eject` copies a Kortix tool into the project so you can change it.', '[Agents](/docs/#agents)'],
  models: ['The models the project offers, and its default model.', '[Models](/docs/#models)'],
  gateway: ['LLM gateway routing, budgets, keys, usage, logs and tests.', '[Models](/docs/#models)'],
  connectors: ['Add, connect, call and govern connectors. `moves` and `move` move Pipedream and Composio connectors to Kortix.', '[Connectors](/docs/#connectors)'],
  secrets: ['Project secrets, their exposure and who can use them.', '[Security](/docs/#security)'],
  providers: ['Connect model providers with an API key or OAuth.', '[Models](/docs/#models)'],
  env: ['Pull secret names into a `.env` file, or push a `.env` file as secrets.', '[Security](/docs/#security)'],
  channels: ['Slack and Microsoft Teams connections, and the agent each channel runs.', '[Channels](/docs/#channels)'],
  sandboxes: ['Sandbox templates, their builds and their health.', '[Computers](/docs/#computers)'],
  apps: ['Deploy and manage Apps: sites and servers with stable Kortix URLs.', '[Apps reference](/docs/#apps-reference)'],
  marketplace: ['Search, show, install and uninstall marketplace skills.', '[Skills](/docs/#skills)'],
  files: ['Read the committed repository: files, history, branches, commits, diffs and a zip download.', '[Git](/docs/#git)'],
  drive: ["The project's Drive: list, read, upload, move and delete files, and share folders.", '[Memory and Drive](/docs/#memory-and-drive)'],
  cr: ['Change requests: list, show, diff, open, merge, request changes, close and reopen.', '[Git](/docs/#git)'],
  review: ['The review inbox: change requests, held connector calls and submitted outputs.', '[Git](/docs/#git)'],
  triggers: ['List, add, fire, enable, disable, pause and resume triggers.', '[Automations](/docs/#automations)'],
  reminders: ['Prompt one session later or on repeat. `kortix remind "…" --in 24h` adds one.', '[Automations](/docs/#automations)'],
  capture: ['Search the Capture timeline of the person you act for. Capture is off until an account admin turns it on.', '[Capture](/docs/capture)'],
  access: ['Grant, list and revoke role assignments for people, groups and agents.', '[Teams](/docs/#teams)'],
  roles: ['System and custom roles, and what each one permits.', '[Teams](/docs/#teams)'],
  permissions: ['The permission catalog roles are built from. `kortix perms` is the same command.', '[Teams](/docs/#teams)'],
  audit: ['Read the account audit log.', '[Teams](/docs/#teams)'],
  grants: ['Assign agents to members or groups.', '[Teams](/docs/#teams)'],
  feedback: ['Send product feedback to the Kortix team.', '[Maintain the CLI](#maintain-the-cli)'],
  update: ['Replace the binary with the latest release.', '[Maintain the CLI](#maintain-the-cli)'],
  uninstall: ['Remove the CLI from this machine.', '[Maintain the CLI](#maintain-the-cli)'],
  help: ["The command list. `kortix help <command>` prints one command's help.", '[Conventions](#conventions)'],
  version: ['Print the CLI version.', '[Maintain the CLI](#maintain-the-cli)'],
};

/** The bold label of a section: its title, else its band; `—` and `&` read as words. */
const label = (tier, section) =>
  (section.title || (tier.label === 'CLI' ? 'The CLI itself' : tier.label)).replace(' — ', ', ').replace(' & ', ' and ');

export async function renderCliCommandTables() {
  const { TIERS } = await import(pathToFileURL(resolve(repositoryRoot, 'apps/cli/src/command-table.ts')).href);
  const listed = new Set();
  const blocks = TIERS.flatMap((tier) =>
    tier.sections.flatMap((section) => {
      const commands = section.commands.filter(
        (command) => !(command.name in UNDOCUMENTED) && (!command.featureFlag || onByDefault(command.featureFlag)),
      );
      if (commands.length === 0) return [];
      const rows = commands.map((command) => {
        listed.add(command.name);
        const doc = COMMANDS[command.name];
        if (!doc) throw new Error(`kortix ${command.name} is in apps/cli/src/command-table.ts but not in ${SCRIPT} COMMANDS`);
        const usage = USAGE[command.name] ?? (command.args ? `${command.name} ${command.args}` : command.name);
        return `| ${cell(code(usage))} | ${cell(doc[0])} | ${cell(doc[1])} |`;
      });
      return [[`**${label(tier, section)}**`, '', '| Command | What it does | See |', '| --- | --- | --- |', ...rows].join('\n')];
    }),
  );
  const stale = Object.keys(COMMANDS).filter((name) => !listed.has(name));
  if (stale.length) throw new Error(`${SCRIPT} COMMANDS describes ${stale.join(', ')}, which kortix --help does not list`);
  return [
    `{/* Generated by ${SCRIPT} from apps/cli/src/command-table.ts and the COMMANDS rows of the script. Edit those, then run the script. */}`,
    ...blocks,
  ].join('\n\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRegionGenerator('cli-commands', SCRIPT, renderCliCommandTables);
}
