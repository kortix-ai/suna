import { loadAuth, loadAuthForHost } from './api/auth.ts';
import { ApiError, clientFromAuth, type ApiClient } from './api/client.ts';
import { resolveProjectId } from './project-link.ts';
import { C, status } from './style.ts';

interface ProjectContextOpts {
  /** Override project via --project flag or KORTIX_PROJECT_ID env. */
  projectArg?: string;
  /** Override active host for this invocation via --host flag. */
  hostArg?: string;
}

/**
 * Common setup for any project-scoped command: validate auth, resolve a
 * project id, build an API client. Prints a friendly error and returns
 * null if either piece is missing.
 *
 * Backward-compat: callers that pass a string get the legacy
 * `(projectArg)` shape; callers that need --host pass an object.
 */
export function resolveProjectContext(
  optsOrProjectArg?: ProjectContextOpts | string,
): { client: ApiClient; projectId: string } | null {
  const opts: ProjectContextOpts =
    typeof optsOrProjectArg === 'string'
      ? { projectArg: optsOrProjectArg }
      : optsOrProjectArg ?? {};

  const auth = opts.hostArg ? loadAuthForHost(opts.hostArg) : loadAuth();
  if (!auth?.token) {
    if (opts.hostArg) {
      process.stderr.write(
        `${status.err(`Host "${opts.hostArg}" is not logged in.`)} Run ` +
          `${C.cyan}kortix login --host ${opts.hostArg}${C.reset}.\n`,
      );
    } else {
      process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    }
    return null;
  }
  const projectId = resolveProjectId(opts.projectArg);
  if (!projectId) {
    process.stderr.write(
      `${status.err('No project linked.')} Run \`kortix projects link\` ` +
        `or pass ${C.cyan}--project <id>${C.reset}.\n`,
    );
    return null;
  }
  return { client: clientFromAuth(auth), projectId };
}

/** Print an HTTP error in a consistent style + return exit code 1. */
export function surfaceApiError(err: unknown): number {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      process.stderr.write(
        `${status.err('Token rejected. Run `kortix login` to re-authenticate.')}\n`,
      );
    } else if (err.status === 403) {
      process.stderr.write(
        `${status.err('Forbidden — you may not have permission on this project.')}\n`,
      );
    } else if (err.status === 404) {
      process.stderr.write(`${status.err(err.message || 'Not found.')}\n`);
    } else {
      process.stderr.write(`${status.err(`HTTP ${err.status}: ${err.message}`)}\n`);
    }
    return 1;
  }
  process.stderr.write(`${status.err((err as Error).message)}\n`);
  return 1;
}

/** Find and pull out a flag value from argv (`--project foo` or
 *  `--project=foo`). Mutates the array — caller passes a sliced copy. */
export function takeFlagValue(argv: string[], names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    for (const n of names) {
      if (a === n) {
        const v = argv[i + 1];
        if (!v || v.startsWith('-')) throw new Error(`${n} requires a value`);
        argv.splice(i, 2);
        return v;
      }
      const eq = `${n}=`;
      if (a.startsWith(eq)) {
        const v = a.slice(eq.length);
        argv.splice(i, 1);
        return v;
      }
    }
  }
  return undefined;
}

export function takeFlagBool(argv: string[], names: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    if (names.includes(argv[i])) {
      argv.splice(i, 1);
      return true;
    }
  }
  return false;
}
