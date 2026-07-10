import type { Auth } from './api/auth.ts';
import { clientFromAuth } from './api/client.ts';
import {
  activeAccount,
  defaultProject,
  setDefaultProject,
  type DefaultProjectRef,
} from './api/config.ts';
import { selectFromList } from './tui-select.ts';
import { C, status } from './style.ts';
import type { ProjectSummary } from './api/types.ts';

export interface BindOutcome {
  project: DefaultProjectRef | null;
  /** True when setDefaultProject was called during this invocation. */
  bound: boolean;
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function bindableAccountId(auth: Auth): string | undefined {
  return activeAccount()?.id ?? auth.account_id ?? undefined;
}

/**
 * The always-bound invariant: make sure the active host has a global
 * default project, creating the binding interactively when possible.
 *
 *   - already bound        → return it, do nothing
 *   - zero projects        → hint at `kortix init`, return null
 *   - exactly one project  → bind it automatically (no prompt)
 *   - several + TTY        → picker (Esc skips)
 *   - several + non-TTY    → hint, return null
 *
 * Never throws: any API failure degrades to "not bound" with the reason
 * on stderr, so callers (login epilogue, unbound-command recovery) can
 * fall back to their existing error paths.
 */
export async function ensureDefaultProjectBinding(
  auth: Auth,
  opts: { promptTitle?: string } = {},
): Promise<BindOutcome> {
  const existing = defaultProject();
  if (existing) return { project: existing, bound: false };

  let projects: ProjectSummary[];
  try {
    projects = await clientFromAuth(auth, { accountId: bindableAccountId(auth) }).get<
      ProjectSummary[]
    >('/projects');
  } catch (err) {
    process.stderr.write(
      `${C.dim}Could not list projects to bind a default: ${(err as Error).message}${C.reset}\n`,
    );
    return { project: null, bound: false };
  }

  if (projects.length === 0) {
    process.stderr.write(
      `${C.dim}No projects in this account yet — create your first with ${C.reset}${C.cyan}kortix init <name>${C.reset}${C.dim} then ${C.reset}${C.cyan}kortix ship${C.reset}${C.dim}.${C.reset}\n`,
    );
    return { project: null, bound: false };
  }

  let picked: ProjectSummary | null = null;
  if (projects.length === 1) {
    picked = projects[0];
  } else if (isInteractive()) {
    picked = await selectFromList<ProjectSummary>({
      title: opts.promptTitle ?? 'Pick your default project',
      items: projects.map((p) => ({ value: p, label: p.name, sublabel: p.project_id })),
    });
    if (!picked) {
      process.stderr.write(
        `${C.dim}Skipped. Bind one any time with ${C.reset}${C.cyan}kortix projects use${C.reset}${C.dim}.${C.reset}\n`,
      );
      return { project: null, bound: false };
    }
  } else {
    process.stderr.write(
      `${C.dim}No default project bound. Run ${C.reset}${C.cyan}kortix projects use${C.reset}${C.dim} to pick one.${C.reset}\n`,
    );
    return { project: null, bound: false };
  }

  const ref: DefaultProjectRef = {
    project_id: picked.project_id,
    account_id: picked.account_id,
    name: picked.name,
  };
  setDefaultProject(ref);
  process.stderr.write(
    `${status.ok(`Default project: ${C.bold}${picked.name}${C.reset}`)} ${C.dim}(change with \`kortix projects use\`)${C.reset}\n`,
  );
  return { project: ref, bound: true };
}
