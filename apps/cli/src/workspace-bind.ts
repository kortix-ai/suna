import type { Auth } from './api/auth.ts';
import { clientFromAuth } from './api/client.ts';
import {
  activeAccount,
  defaultWorkspace,
  setDefaultWorkspace,
  type DefaultWorkspaceRef,
} from './api/config.ts';
import { selectFromList } from './tui-select.ts';
import { C, status } from './style.ts';
import type { WorkspaceSummary } from './api/types.ts';

export interface BindOutcome {
  workspace: DefaultWorkspaceRef | null;
  /** True when setDefaultWorkspace was called during this invocation. */
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
 * default workspace, creating the binding interactively when possible.
 *
 *   - already bound        → return it, do nothing
 *   - zero workspaces      → hint at `kortix init`, return null
 *   - exactly one workspace → bind it automatically (no prompt)
 *   - several + TTY        → picker (Esc skips)
 *   - several + non-TTY    → hint, return null
 *
 * Never throws: any API failure degrades to "not bound" with the reason
 * on stderr, so callers (login epilogue, unbound-command recovery) can
 * fall back to their existing error paths.
 */
export async function ensureDefaultWorkspaceBinding(
  auth: Auth,
  opts: {
    promptTitle?: string;
    /**
     * Say nothing on ANY path that ends without a bound workspace — an empty
     * account, a failed list, a declined picker, a non-TTY with several to
     * choose from.
     *
     * For a caller that has a FALLBACK — `locateSessionAnywhere` scans the
     * account's siblings next — the "no workspaces here" note is not the
     * outcome, it is a step. Printing it announces a failure that is about to
     * be recovered from, which reads as the command having failed even when it
     * goes on to succeed.
     */
    quiet?: boolean;
  } = {},
): Promise<BindOutcome> {
  const existing = defaultWorkspace();
  if (existing) return { workspace: existing, bound: false };

  let workspaces: WorkspaceSummary[];
  try {
    workspaces = await clientFromAuth(auth, { accountId: bindableAccountId(auth) }).get<
      WorkspaceSummary[]
    >('/workspaces');
  } catch (err) {
    if (!opts.quiet) {
      process.stderr.write(
        `${C.dim}Could not list workspaces to bind a default: ${(err as Error).message}${C.reset}\n`,
      );
    }
    return { workspace: null, bound: false };
  }

  if (workspaces.length === 0) {
    // "in this account" matters: the user may well have workspaces, just under a
    // different account on the same host. Telling them to create their first
    // one would be wrong, and this message used to say exactly that.
    if (!opts.quiet) {
      process.stderr.write(
        `${C.dim}No workspaces in this account — create one with ${C.reset}${C.cyan}kortix init <name>${C.reset}${C.dim}, or switch accounts with ${C.reset}${C.cyan}kortix accounts use${C.reset}${C.dim}.${C.reset}\n`,
      );
    }
    return { workspace: null, bound: false };
  }

  let picked: WorkspaceSummary | null = null;
  if (workspaces.length === 1) {
    picked = workspaces[0];
  } else if (isInteractive()) {
    picked = await selectFromList<WorkspaceSummary>({
      title: opts.promptTitle ?? 'Pick your default workspace',
      items: workspaces.map((workspace) => ({
        value: workspace,
        label: workspace.name,
        sublabel: workspace.workspace_id,
      })),
    });
    if (!picked) {
      if (!opts.quiet) {
        process.stderr.write(
          `${C.dim}Skipped. Bind one any time with ${C.reset}${C.cyan}kortix workspaces use${C.reset}${C.dim}.${C.reset}\n`,
        );
      }
      return { workspace: null, bound: false };
    }
  } else {
    if (!opts.quiet) {
      process.stderr.write(
        `${C.dim}No default workspace bound. Run ${C.reset}${C.cyan}kortix workspaces use${C.reset}${C.dim} to pick one.${C.reset}\n`,
      );
    }
    return { workspace: null, bound: false };
  }

  const ref: DefaultWorkspaceRef = {
    workspace_id: picked.workspace_id,
    account_id: picked.account_id,
    name: picked.name,
  };
  setDefaultWorkspace(ref);
  process.stderr.write(
    `${status.ok(`Default workspace: ${C.bold}${picked.name}${C.reset}`)} ${C.dim}(change with \`kortix workspaces use\`)${C.reset}\n`,
  );
  return { workspace: ref, bound: true };
}
