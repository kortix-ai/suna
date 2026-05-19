import { spawnSync } from 'node:child_process';
import { loadAuth } from '../api/auth.ts';
import { ApiError, clientFromAuth } from '../api/client.ts';
import {
  clearLink,
  loadLink,
  resolveProjectId,
  saveLink,
} from '../project-link.ts';
import { selectFromList } from '../tui-select.ts';
import { C, pad, status } from '../style.ts';
import type { ProjectSummary } from '../api/types.ts';

const HELP = `Usage: kortix projects <subcommand>

Subcommands:
  ls                   List projects in your active account
  info [<id>]          Show one project (defaults to the linked one)
  link [<id>]          Bind cwd to a remote project (writes .kortix/link.json)
  unlink               Remove .kortix/link.json from cwd
  open [<id>]          Open the dashboard URL for one project

Run \`kortix projects <subcommand> --help\` for options.
`;

export async function runProjects(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case 'ls':
      return projectsLs();
    case 'info':
      return projectsInfo(rest[0]);
    case 'link':
      return projectsLink(rest[0]);
    case 'unlink':
      return projectsUnlink();
    case 'open':
      return projectsOpen(rest[0]);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

function requireAuth() {
  const auth = loadAuth();
  if (!auth?.token) {
    process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    return null;
  }
  return auth;
}

async function projectsLs(): Promise<number> {
  const auth = requireAuth();
  if (!auth) return 1;
  const client = clientFromAuth(auth);

  let projects: ProjectSummary[];
  try {
    projects = await client.get<ProjectSummary[]>('/projects');
  } catch (err) {
    return surface(err);
  }

  if (projects.length === 0) {
    process.stdout.write(`${C.dim}No projects in this account.${C.reset}\n`);
    return 0;
  }

  const linked = loadLink()?.project_id;
  const nameW = Math.max(...projects.map((p) => p.name.length), 4);
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('NAME', nameW)}   ${pad('REPO', 40)}   BRANCH    UPDATED${C.reset}\n`,
  );
  for (const p of projects) {
    const marker = p.project_id === linked ? `${C.green}● ${C.reset}` : '  ';
    const repo = trimMid(p.repo_url, 40);
    const updated = formatRelative(p.updated_at);
    process.stdout.write(
      `${marker}${pad(p.name, nameW)}   ${pad(repo, 40)}   ${pad(p.default_branch, 8)}  ${C.faded}${updated}${C.reset}\n`,
    );
  }
  process.stdout.write(`\n  ${C.dim}${projects.length} project${projects.length === 1 ? '' : 's'}${C.reset}\n\n`);
  return 0;
}

async function projectsInfo(arg?: string): Promise<number> {
  const auth = requireAuth();
  if (!auth) return 1;
  const id = arg ?? resolveProjectId();
  if (!id) {
    process.stderr.write(
      `${status.err('No project linked. Run `kortix projects link` or pass an id.')}\n`,
    );
    return 1;
  }
  const client = clientFromAuth(auth);
  let p: ProjectSummary;
  try {
    p = await client.get<ProjectSummary>(`/projects/${id}`);
  } catch (err) {
    return surface(err);
  }
  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${p.name}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}project_id ${C.reset}${p.project_id}\n`);
  process.stdout.write(`  ${C.dim}account_id ${C.reset}${p.account_id}\n`);
  process.stdout.write(`  ${C.dim}repo       ${C.reset}${p.repo_url}\n`);
  process.stdout.write(`  ${C.dim}branch     ${C.reset}${p.default_branch}\n`);
  process.stdout.write(`  ${C.dim}manifest   ${C.reset}${p.manifest_path}\n`);
  process.stdout.write(`  ${C.dim}status     ${C.reset}${p.status}\n`);
  process.stdout.write(`  ${C.dim}updated    ${C.reset}${formatRelative(p.updated_at)}\n\n`);
  return 0;
}

async function projectsLink(arg?: string): Promise<number> {
  const auth = requireAuth();
  if (!auth) return 1;
  const client = clientFromAuth(auth);

  let target: ProjectSummary | null = null;
  if (arg) {
    try {
      target = await client.get<ProjectSummary>(`/projects/${arg}`);
    } catch (err) {
      return surface(err);
    }
  } else {
    let list: ProjectSummary[];
    try {
      list = await client.get<ProjectSummary[]>('/projects');
    } catch (err) {
      return surface(err);
    }
    if (list.length === 0) {
      process.stderr.write(`${status.err('No projects in this account to link to.')}\n`);
      return 1;
    }
    const picked = await selectFromList<ProjectSummary>({
      title: `Pick a project to link to ${process.cwd()}`,
      items: list.map((p) => ({
        value: p,
        label: p.name,
        sublabel: p.project_id,
      })),
    });
    if (!picked) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
    target = picked;
  }

  if (!target) {
    process.stderr.write(`${status.err('Could not resolve a project.')}\n`);
    return 1;
  }

  saveLink({
    project_id: target.project_id,
    account_id: target.account_id,
    linked_at: new Date().toISOString(),
  });
  process.stdout.write(
    `${status.ok(`Linked ${C.bold}${target.name}${C.reset}${C.dim} → .kortix/link.json${C.reset}`)}\n`,
  );
  return 0;
}

async function projectsUnlink(): Promise<number> {
  const existing = loadLink();
  clearLink();
  if (existing) {
    process.stdout.write(`${status.ok(`Unlinked ${C.dim}(was ${existing.project_id})${C.reset}`)}\n`);
  } else {
    process.stdout.write(`${C.dim}Not linked. Nothing to do.${C.reset}\n`);
  }
  return 0;
}

async function projectsOpen(arg?: string): Promise<number> {
  const auth = requireAuth();
  if (!auth) return 1;
  const id = arg ?? resolveProjectId();
  if (!id) {
    process.stderr.write(`${status.err('No project linked. Pass an id or link first.')}\n`);
    return 1;
  }
  const url = `${webDashboardUrl(auth.api_base)}/projects/${id}`;
  process.stdout.write(`${C.dim}Opening ${url}${C.reset}\n`);
  openInBrowser(url);
  return 0;
}

// ── helpers ────────────────────────────────────────────────────────────────

function surface(err: unknown): number {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      process.stderr.write(
        `${status.err('Token rejected. Run `kortix login` to re-authenticate.')}\n`,
      );
    } else {
      process.stderr.write(`${status.err(`HTTP ${err.status}: ${err.message}`)}\n`);
    }
    return 1;
  }
  process.stderr.write(`${status.err((err as Error).message)}\n`);
  return 1;
}

function trimMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function webDashboardUrl(apiBase: string): string {
  try {
    const url = new URL(apiBase);
    if (url.hostname.startsWith('api.')) url.hostname = url.hostname.slice(4);
    return url.origin;
  } catch {
    return 'https://kortix.com';
  }
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawnSync(cmd, args, { stdio: 'ignore' });
}
