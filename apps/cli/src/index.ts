#!/usr/bin/env bun
import { printBanner } from './banner.ts';
import { runAccess } from './commands/access.ts';
import { runAccounts } from './commands/accounts.ts';
import { runAgents } from './commands/agents.ts';
import { appsExperimentalEnabled, runApps } from './commands/apps.ts';
import { runChannels } from './commands/channels.ts';
import { runConnectors } from './commands/connectors.ts';
import { runCr } from './commands/cr.ts';
import { runEnv } from './commands/env.ts';
import { runExecutor } from './commands/executor.ts';
import { runFiles } from './commands/files.ts';
import { runGrants } from './commands/grants.ts';
import { runHosts } from './commands/hosts.ts';
import { runInit } from './commands/init.ts';
import { runLogin } from './commands/login.ts';
import { runLogout } from './commands/logout.ts';
import { runMarketplace } from './commands/marketplace.ts';
import { runProjects } from './commands/projects.ts';
import { runRegistry } from './commands/registry.ts';
import { runRoles } from './commands/roles.ts';
import { runSandboxes } from './commands/sandboxes.ts';
import { runSchema } from './commands/schema.ts';
import { runSecrets } from './commands/secrets.ts';
import { runSelfHost } from './commands/self-host.ts';
import { runSessionsChat } from './commands/sessions-chat.ts';
import { runSessions } from './commands/sessions.ts';
import { runShip } from './commands/ship.ts';
import { runTriggers } from './commands/triggers.ts';
import { runUninstall } from './commands/uninstall.ts';
import { runUpdate } from './commands/update.ts';
import { runValidate } from './commands/validate.ts';
import { runWhoami } from './commands/whoami.ts';
import { renderContext, renderHostNotice } from './host-notice.ts';
import { C, header, pad, rule, visibleWidth } from './style.ts';
import { getUpdateNotice } from './update-check.ts';

// CI bakes the real version via --define process.env.KORTIX_CLI_VERSION (the
// unified X.Y.Z on release, X.Y.Z-dev.<sha> on dev). This fallback only applies
// to a bare `bun run src/index.ts` during local dev.
const VERSION = process.env.KORTIX_CLI_VERSION ?? 'dev';

interface Command {
  name: string;
  args?: string;
  blurb: string;
}

interface CommandSection {
  title: string;
  commands: readonly Command[];
}

interface CommandTier {
  /** Band label above the tier's sections — the mental bucket, not a command. */
  label: string;
  sections: readonly CommandSection[];
}

// The help layout is three tiers matching how you actually think about the CLI:
// what lives OUTSIDE any project (who you are, which cloud/account, which
// projects exist), what operates ON the linked project (its code, its agents &
// integrations, its sessions, its access), and the CLI tool itself. Order +
// membership here IS the layout. `apps` is spliced into "Agents & integrations"
// only when its experimental flag is on (see appsExperimentalEnabled in
// ./commands/apps.ts), staying hidden without touching registration/dispatch.
const TIERS: readonly CommandTier[] = [
  {
    label: 'Account',
    sections: [
      {
        title: 'Authentication',
        commands: [
          { name: 'login', blurb: 'Authenticate against the Kortix cloud' },
          { name: 'logout', blurb: 'Remove the stored auth token' },
          { name: 'whoami', blurb: 'Show the currently authenticated user' },
          { name: 'token', blurb: 'Show the active token context (project/session/agent grants)' },
        ],
      },
      {
        title: 'Hosts & accounts',
        commands: [
          { name: 'hosts', args: '<subcommand>', blurb: 'Manage + switch Kortix API hosts' },
          {
            name: 'accounts',
            args: '<subcommand>',
            blurb: 'List + switch the active account (multi-account logins)',
          },
          {
            name: 'self-host',
            args: '<subcommand>',
            blurb: 'Run your own Kortix Cloud from Docker images',
          },
        ],
      },
      {
        title: 'Projects',
        commands: [
          {
            name: 'init',
            args: '[project-name]',
            blurb: 'Start a new Kortix project (a fresh standalone directory)',
          },
          {
            name: 'projects',
            args: '<subcommand>',
            blurb: 'List, link, set-default, open Kortix cloud projects',
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
            name: 'schema',
            args: '[--version 1|2]',
            blurb: 'Print the canonical kortix.yaml/kortix.toml JSON Schema',
          },
        ],
      },
      {
        title: 'Agents & integrations',
        commands: [
          { name: 'agents', args: '<subcommand>', blurb: 'Set which model each agent runs on' },
          {
            name: 'connectors',
            args: '<subcommand>',
            blurb: 'Manage integrations agents call as tools (Pipedream/MCP/HTTP)',
          },
          { name: 'secrets', args: '<subcommand>', blurb: 'Manage project secrets (project-scoped)' },
          { name: 'env', args: '<subcommand>', blurb: 'Pull/push project secrets as a dotenv file' },
          {
            name: 'channels',
            args: '<subcommand>',
            blurb: 'Connect Slack to this project — `connect` prints a one-click install link',
          },
          {
            name: 'sandboxes',
            args: '<subcommand>',
            blurb: 'Manage sandbox images: templates, builds, health',
          },
          {
            name: 'marketplace',
            args: '<subcommand>',
            blurb: 'Search, show, install, and inspect marketplace items',
          },
          {
            name: 'executor',
            args: '<subcommand>',
            blurb: 'Call connectors as tools (discover/describe/call) + run the MCP server',
          },
          ...(appsExperimentalEnabled()
            ? [{ name: 'apps', args: '<subcommand>', blurb: 'Manage deployable apps (experimental)' }]
            : []),
        ],
      },
      {
        title: 'Sessions & work',
        commands: [
          { name: 'sessions', args: '<subcommand>', blurb: 'List, create, restart project sessions' },
          {
            name: 'chat',
            args: '[session-id]',
            blurb: "Talk to a session's agent (REPL or --prompt)",
          },
          { name: 'files', args: '<subcommand>', blurb: 'Browse repo files, commits, branches, diffs' },
          { name: 'cr', args: '<subcommand>', blurb: 'Open, review, merge change requests' },
          { name: 'triggers', args: '<subcommand>', blurb: 'List, fire, enable/disable triggers' },
        ],
      },
      {
        title: 'Access & permissions',
        commands: [
          {
            name: 'access',
            args: '<subcommand>',
            blurb: 'Manage who can use this project (invite/grant/revoke)',
          },
          {
            name: 'roles',
            args: '<subcommand>',
            blurb: 'Manage IAM custom roles + policy assignments (account-scoped)',
          },
          {
            name: 'grants',
            args: '<subcommand>',
            blurb: "Assign agents to members or groups (they inherit the agent's skills/connectors/secrets)",
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

/** A faded, labeled divider that bands a tier above its (bold) section titles. */
function tierBand(label: string): string {
  const dashes = Math.max(0, 56 - visibleWidth(label) - 1);
  return `  ${C.faded}${label} ${'─'.repeat(dashes)}${C.reset}`;
}

function renderHelp(): string {
  const allCommands = TIERS.flatMap((t) => t.sections.flatMap((s) => s.commands));
  const labelWidth = Math.max(
    ...allCommands.map((c) => (c.args ? `${c.name} ${c.args}` : c.name).length),
  );
  const lines: string[] = [];
  lines.push('');
  lines.push(header('Kortix CLI', VERSION));
  lines.push(rule());
  for (const tier of TIERS) {
    const sections = tier.sections.filter((s) => s.commands.length > 0);
    if (sections.length === 0) continue;
    lines.push('');
    lines.push(tierBand(tier.label));
    for (const section of sections) {
      lines.push('');
      if (section.title) lines.push(`  ${C.white}${C.bold}${section.title}${C.reset}`);
      for (const cmd of section.commands) {
        const label = cmd.args ? `${cmd.name} ${C.faded}${cmd.args}${C.reset}` : cmd.name;
        lines.push(`  ${pad(label, labelWidth)}   ${C.dim}${cmd.blurb}${C.reset}`);
      }
    }
  }
  lines.push('');
  lines.push(
    `  ${C.dim}Run${C.reset} ${C.cyan}kortix <subcommand> --help${C.reset} ${C.dim}for command-specific options.${C.reset}`,
  );
  lines.push('');
  return lines.join('\n');
}

function printVersion(): void {
  process.stdout.write(`${header('Kortix CLI', VERSION)}\n`);
}

// The landing screen: ASCII banner → host/account/project context → update
// notice → the grouped command list. `kortix`, `kortix help`, and
// `kortix --help` all render EXACTLY this, so there's no "which one shows the
// banner/context" surprise.
async function printLanding(): Promise<void> {
  printBanner();
  // Always surface what host/account/project commands will act on.
  process.stdout.write(`${renderContext()}\n`);
  const notice = await getUpdateNotice(VERSION, { allowFetch: true, style: 'box' });
  if (notice) process.stdout.write(`${notice}\n`);
  process.stdout.write(renderHelp());
}

async function main(argv: string[]): Promise<number> {
  // Only the LEADING `--version`/`-v` is the global "print the CLI's own
  // version" flag. Scanning the whole argv used to hijack any subcommand's
  // own same-named flag (e.g. `kortix schema --version 2`, `kortix self-host
  // update --version <tag>`) before it ever reached the subcommand parser.
  if (argv[0] === '--version' || argv[0] === '-v') {
    printVersion();
    return 0;
  }
  // Bare `kortix` and explicit help are the same landing screen — no difference.
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    await printLanding();
    return 0;
  }
  if (argv[0] === 'version') {
    printVersion();
    const notice = await getUpdateNotice(VERSION, { allowFetch: true, style: 'box' });
    if (notice) process.stdout.write(`${notice}\n`);
    return 0;
  }
  // `executor` is a MACHINE surface (the in-sandbox agent parses stdout as JSON,
  // and `executor mcp` speaks JSON-RPC on stdout). Skip the human-oriented host
  // + update notices so its output stays clean.
  if (argv[0] !== 'executor') {
    printActiveHostNotice(argv);
    await printUpdateNoticeForCommand(argv[0]);
  }
  if (argv[0] === 'init') {
    return runInit(argv.slice(1));
  }
  // `deploy` is kept as a familiar alias for `ship`.
  if (argv[0] === 'ship' || argv[0] === 'deploy') {
    return runShip(argv.slice(1));
  }
  if (argv[0] === 'validate') {
    return runValidate(argv.slice(1));
  }
  if (argv[0] === 'schema') {
    return runSchema(argv.slice(1));
  }
  if (argv[0] === 'login') {
    return runLogin(argv.slice(1));
  }
  if (argv[0] === 'logout') {
    return runLogout(argv.slice(1));
  }
  if (argv[0] === 'whoami') {
    return runWhoami(argv.slice(1));
  }
  if (argv[0] === 'token') {
    return runWhoami(['--token-only', ...argv.slice(1)]);
  }
  if (argv[0] === 'projects') {
    return runProjects(argv.slice(1));
  }
  if (argv[0] === 'hosts') {
    return runHosts(argv.slice(1));
  }
  if (argv[0] === 'accounts') {
    return runAccounts(argv.slice(1));
  }
  if (argv[0] === 'secrets') {
    return runSecrets(argv.slice(1));
  }
  if (argv[0] === 'agents') {
    return runAgents(argv.slice(1));
  }
  if (argv[0] === 'self-host') {
    return runSelfHost(argv.slice(1));
  }
  if (argv[0] === 'env') {
    return runEnv(argv.slice(1));
  }
  if (argv[0] === 'sessions') {
    return runSessions(argv.slice(1));
  }
  if (argv[0] === 'chat') {
    return runSessionsChat(argv.slice(1));
  }
  if (argv[0] === 'files') {
    return runFiles(argv.slice(1));
  }
  if (argv[0] === 'triggers') {
    return runTriggers(argv.slice(1));
  }
  if (argv[0] === 'channels') {
    return runChannels(argv.slice(1));
  }
  if (argv[0] === 'connectors') {
    return runConnectors(argv.slice(1));
  }
  if (argv[0] === 'executor') {
    return runExecutor(argv.slice(1));
  }
  if (argv[0] === 'marketplace') {
    return runMarketplace(argv.slice(1));
  }
  if (argv[0] === 'registry') {
    process.stderr.write(
      `${C.yellow}developer command:${C.reset} registry is an internal marketplace authoring format; use ${C.cyan}kortix marketplace${C.reset} for normal install/search.\n`,
    );
    return runRegistry(argv.slice(1));
  }
  if (argv[0] === 'sandboxes') {
    return runSandboxes(argv.slice(1));
  }
  if (argv[0] === 'apps') {
    return runApps(argv.slice(1));
  }
  if (argv[0] === 'cr') {
    return runCr(argv.slice(1));
  }
  if (argv[0] === 'access') {
    return runAccess(argv.slice(1));
  }
  if (argv[0] === 'roles') {
    return runRoles(argv.slice(1));
  }
  if (argv[0] === 'grants') {
    return runGrants(argv.slice(1));
  }
  if (argv[0] === 'update') {
    return runUpdate(argv.slice(1));
  }
  if (argv[0] === 'uninstall') {
    return runUninstall(argv.slice(1));
  }
  // Anything else is an unknown command. This must NEVER fall through to a
  // project scaffold — `kortix <new-project-name>` used to, which turned
  // every mistyped subcommand into a freshly scaffolded directory in cwd.
  // Scaffolding is explicit-only: `kortix init [project-name]`.
  const suggestion = closestCommand(argv[0]);
  const lines = [`${C.red}kortix:${C.reset} unknown command \`${argv[0]}\``];
  if (suggestion) lines.push(`       Did you mean ${C.cyan}kortix ${suggestion}${C.reset}?`);
  lines.push(
    `       Run ${C.cyan}kortix --help${C.reset} for the full list, or ${C.cyan}kortix init <name>${C.reset} to start a new project.`,
  );
  process.stderr.write(`${lines.join('\n')}\n`);
  return 2;
}

const KNOWN_COMMANDS = [
  'init',
  'ship',
  'deploy',
  'validate',
  'schema',
  'self-host',
  'login',
  'logout',
  'whoami',
  'token',
  'hosts',
  'accounts',
  'projects',
  'sessions',
  'chat',
  'files',
  'cr',
  'triggers',
  'connectors',
  'secrets',
  'env',
  'channels',
  'sandboxes',
  'marketplace',
  'executor',
  'registry',
  'apps',
  'agents',
  'access',
  'roles',
  'grants',
  'update',
  'uninstall',
  'help',
  'version',
] as const;

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

function closestCommand(input: string): string | undefined {
  const needle = input.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const name of KNOWN_COMMANDS) {
    const distance = editDistance(needle, name);
    // The distance cap alone lets tiny inputs match anything short ("us" →
    // "cr"), so also require most of the input to survive the edit.
    if (distance <= 2 && distance < needle.length && (best === undefined || distance < best.distance)) {
      best = { name, distance };
    }
  }
  return best?.name;
}

function printActiveHostNotice(argv: readonly string[]): void {
  const notice = renderHostNotice(argv);
  if (notice) process.stderr.write(notice);
}

// Passive, cache-only nudge for subcommands (never touches the network, so it
// adds no latency). The prominent box only shows on the bare landing screen.
// `update`/`uninstall` skip it — they're about the binary itself.
async function printUpdateNoticeForCommand(command: string): Promise<void> {
  if (command === 'update' || command === 'uninstall') return;
  const notice = await getUpdateNotice(VERSION, { allowFetch: false, style: 'line' });
  if (notice) process.stderr.write(`${notice}\n`);
}

// `process.exit()` does NOT wait for a piped stdout/stderr to flush — on large
// output (e.g. `kortix projects ls --all --json | jq`, or executor JSON the
// in-sandbox agent parses) it drops everything past the ~64KiB pipe buffer,
// producing truncated/invalid output. Instead set the exit code and let the
// runtime flush both streams and exit naturally. Release stdin first so an
// interactive raw-mode read (tui-select / prompts) can't keep the event loop
// alive after the command is done.
function finish(code: number): void {
  process.exitCode = code;
  try {
    process.stdin.pause();
    (process.stdin as unknown as { unref?: () => void }).unref?.();
  } catch {
    /* stdin may not support pause/unref in every environment */
  }
}

main(process.argv.slice(2))
  .then((code) => finish(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${C.red}kortix:${C.reset} ${msg}\n`);
    finish(1);
  });
