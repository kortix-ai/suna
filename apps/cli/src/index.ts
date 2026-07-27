#!/usr/bin/env bun
import { printBanner } from './banner.ts';
import { runAccess } from './commands/access.ts';
import { runAccounts } from './commands/accounts.ts';
import { runAgents } from './commands/agents.ts';
import { runChannels } from './commands/channels.ts';
import { runConnectors } from './commands/connectors.ts';
import { runCr } from './commands/cr.ts';
import { runEnv } from './commands/env.ts';
import { runExecutor } from './commands/executor.ts';
import { runFiles } from './commands/files.ts';
import { runGitCredential } from './commands/git-credential.ts';
import { runGateway } from './commands/gateway.ts';
import { runGrants } from './commands/grants.ts';
import { runHosts } from './commands/hosts.ts';
import { runInit } from './commands/init.ts';
import { runLogin } from './commands/login.ts';
import { runLogout } from './commands/logout.ts';
import { runMarketplace } from './commands/marketplace.ts';
import { runProjects } from './commands/projects.ts';
import { runProviders } from './commands/providers.ts';
import { runRegistry } from './commands/registry.ts';
import { runRoles } from './commands/roles.ts';
import { runSandboxes } from './commands/sandboxes.ts';
import { runSchema } from './commands/schema.ts';
import { runSecrets } from './commands/secrets.ts';
import { runSelfHost } from './commands/self-host.ts';
import { runSessionsChat } from './commands/sessions-chat.ts';
import { runSessions } from './commands/sessions.ts';
import { runShip } from './commands/ship.ts';
import { SYSTEM_SKILLS_COMMAND, runSystemSkills } from './commands/system-skills.ts';
import { runTriggers } from './commands/triggers.ts';
import { runUninstall } from './commands/uninstall.ts';
import { runUpdate } from './commands/update.ts';
import { runValidate } from './commands/validate.ts';
import { runWhoami } from './commands/whoami.ts';
import { renderContext, renderHostNotice } from './host-notice.ts';
import { C, header, pad, rule, visibleWidth } from './style.ts';
import { confirm } from './prompts.ts';
import {
  getUpdateNotice,
  isUpdateSnoozed,
  renderUpdateBox,
  resolveUpdateStatus,
  snoozeUpdate,
} from './update-check.ts';

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

// The help layout leads with the navigable hierarchy — Host › Account ›
// Project › Session, top-down, each with its `use` selection verb — then the
// feature bands that operate ON the linked project, then the CLI tool itself.
// You sign into a HOST, pick an ACCOUNT within it, pick a PROJECT within that,
// and open SESSIONS in the project. Order + membership here IS the layout.
const TIERS: readonly CommandTier[] = [
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
          { name: 'token', blurb: 'Inspect the active token context (project/session/agent grants)' },
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
            blurb: 'List, link, set-default (use), open Kortix cloud projects',
          },
        ],
      },
      {
        title: 'Session — within the project',
        commands: [
          {
            name: 'sessions',
            args: '<subcommand>',
            blurb: 'List, create, restart project sessions',
          },
          {
            name: 'chat',
            args: '[session-id]',
            blurb: "Talk to a session's agent (REPL or --prompt)",
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
            name: 'gateway',
            args: '<subcommand>',
            blurb: 'Configure the LLM gateway: routing, budgets, keys, usage, logs, test',
          },
          {
            name: 'connectors',
            args: '<subcommand>',
            blurb: 'Manage integrations agents call as tools (Pipedream/MCP/HTTP)',
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
        ],
      },
      {
        title: 'Files, changes & triggers',
        commands: [
          {
            name: 'files',
            args: '<subcommand>',
            blurb: 'Browse repo files, commits, branches, diffs',
          },
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
// banner/context" surprise. The one difference is that BARE `kortix` may stop
// at the update notice to ask (see offerInteractiveUpdate) — an explicit help
// request stays a pure, non-blocking render.
async function printLanding(opts: { offerUpdate: boolean }): Promise<void> {
  printBanner();
  // Always surface what host/account/project commands will act on.
  process.stdout.write(`${renderContext()}\n`);
  if (opts.offerUpdate) {
    if (await offerInteractiveUpdate()) return; // binary replaced — this help is stale
  } else {
    const notice = await getUpdateNotice(VERSION, { allowFetch: true, style: 'box' });
    if (notice) process.stdout.write(`${notice}\n`);
  }
  process.stdout.write(renderHelp());
}

/** Can we actually ask a question here? `resolveUpdateStatus` already rules out
 *  CI and a non-TTY stdout; a prompt additionally needs a readable stdin, and
 *  an explicit opt-out for anyone who wants the notice without the question. */
function canPromptForUpdate(): boolean {
  if (process.env.KORTIX_NO_UPDATE_PROMPT) return false;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Bare `kortix` on a terminal: show the update box and offer to install it on
 * the spot, so being out of date takes a deliberate "no" rather than the
 * inertia of never getting around to `kortix update`.
 *
 * Returns true when the binary was replaced — the caller then skips the help
 * screen, which came from the version that no longer exists on disk.
 */
async function offerInteractiveUpdate(): Promise<boolean> {
  const status = await resolveUpdateStatus(VERSION, { allowFetch: true });
  if (!status) return false;

  const askable = canPromptForUpdate() && !isUpdateSnoozed(status.latestTag);
  process.stdout.write(`${renderUpdateBox(status, askable)}\n`);
  if (!askable) return false;

  let accepted: boolean;
  try {
    // Defaults to yes on Enter — the point is to make staying behind the
    // deliberate choice. But a stream that just ENDS is nobody answering, and
    // that must never self-trigger a binary-replacing install.
    accepted = await confirm(`  Update to ${status.latestDisplay} now?`, true, {
      onEndOfInput: false,
    });
  } catch {
    return false; // not really interactive after all — leave the box standing
  }
  if (!accepted) {
    // Remember the "no" so we ask once per release, not once per invocation.
    snoozeUpdate(status.latestTag);
    process.stdout.write(
      `  ${C.dim}Skipped. Run ${C.reset}${C.cyan}kortix update${C.reset}${C.dim} whenever you're ready.${C.reset}\n`,
    );
    return false;
  }

  process.stdout.write('\n');
  if ((await runUpdate([])) !== 0) return false;
  process.stdout.write(`  ${C.dim}Run ${C.reset}${C.cyan}kortix${C.reset}${C.dim} again to pick it up.${C.reset}\n\n`);
  return true;
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
  // Bare `kortix` and explicit help are the same landing screen. Only the bare
  // form offers to update: `kortix --help` is what people (and scripts) reach
  // for to READ something, and it must never block on a question.
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    await printLanding({ offerUpdate: argv.length === 0 });
    return 0;
  }
  if (argv[0] === 'version') {
    printVersion();
    const notice = await getUpdateNotice(VERSION, { allowFetch: true, style: 'box' });
    if (notice) process.stdout.write(`${notice}\n`);
    return 0;
  }
  // Machine-only Git credential-helper protocol. It must never print the
  // human host/update notices that would corrupt key=value output on stdout.
  if (argv[0] === 'git-credential') {
    return runGitCredential(argv.slice(1));
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
  if (argv[0] === 'providers') {
    return runProviders(argv.slice(1));
  }
  if (argv[0] === 'agents') {
    return runAgents(argv.slice(1));
  }
  if (argv[0] === 'gateway') {
    return runGateway(argv.slice(1));
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
  // `system-skills` is the canonical name; `skills` stays a permanent alias
  // because every already-baked sandbox image seeds a kortix-system skill whose
  // live pointer says `kortix skills get <name>`. Both hand the invoked name
  // down so every hint the command prints matches how it was called.
  if (argv[0] === SYSTEM_SKILLS_COMMAND || argv[0] === 'skills') {
    return runSystemSkills(argv.slice(1), argv[0]);
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
  'providers',
  'env',
  'gateway',
  'channels',
  'sandboxes',
  'marketplace',
  'system-skills',
  'skills',
  'executor',
  'registry',
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
    if (
      distance <= 2 &&
      distance < needle.length &&
      (best === undefined || distance < best.distance)
    ) {
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
