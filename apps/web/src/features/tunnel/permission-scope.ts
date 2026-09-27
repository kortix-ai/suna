/**
 * The scoped approval the tunnel permission dialog recommends.
 *
 * The API writes `requestedScope` with the same field names the approve route
 * validates (`requestedScopeForOperation` in apps/api/src/tunnel/core/rpc-core.ts):
 * filesystem `{ operations, paths }`, shell `{ commands, workingDir, maxTimeout }`.
 * `scopeFromRequest` pre-fills the editors from those fields, and
 * `approvalScope` turns the edited scope into a body the server accepts.
 */
import type { FilesystemScope, PermissionScope, ShellScope } from './types';
import { getDefaultScope } from './types';

interface PermissionRequestLike {
  capability: string;
  requestedScope?: Record<string, unknown> | null;
}

const FILESYSTEM_OPERATIONS = new Set<string>(['read', 'write', 'list', 'delete']);

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return items.length > 0 ? items : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function scopeFromRequest(request: PermissionRequestLike): PermissionScope {
  const base = getDefaultScope(request.capability);
  const requested = request.requestedScope ?? {};

  switch (request.capability) {
    case 'filesystem': {
      const fsBase = base as FilesystemScope;
      const paths = stringList(requested.paths);
      const operations = stringList(requested.operations)?.filter((operation) =>
        FILESYSTEM_OPERATIONS.has(operation),
      ) as FilesystemScope['operations'] | undefined;
      const maxFileSize = positiveInteger(requested.maxFileSize);
      return {
        ...fsBase,
        paths: paths ?? fsBase.paths,
        operations: operations?.length ? operations : fsBase.operations,
        excludePatterns: stringList(requested.excludePatterns) ?? fsBase.excludePatterns,
        ...(maxFileSize ? { maxFileSize } : {}),
      } satisfies FilesystemScope;
    }
    case 'shell': {
      const shBase = base as ShellScope;
      const workingDir =
        typeof requested.workingDir === 'string' ? requested.workingDir : shBase.workingDir;
      const maxTimeout = positiveInteger(requested.maxTimeout);
      return {
        ...shBase,
        // The server matches the full command string, so the whole command is
        // the scope — not its first word.
        commands: stringList(requested.commands) ?? shBase.commands,
        workingDir,
        ...(maxTimeout ? { maxTimeout } : {}),
      } satisfies ShellScope;
    }
    default:
      return base;
  }
}

/**
 * The body for a scoped approval. Optional fields the user left empty are
 * omitted (the server rejects `workingDir: ''`). A restriction list the user
 * emptied (`paths`, `commands`) is sent as-is: the server refuses an empty
 * list, which is safer than omitting it, because an omitted list means
 * "unrestricted".
 */
export function approvalScope(capability: string, scope: PermissionScope): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(scope as Record<string, unknown>) };
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || value === '') delete body[key];
  }
  if (capability === 'filesystem') {
    if (Array.isArray(body.excludePatterns) && body.excludePatterns.length === 0) {
      delete body.excludePatterns;
    }
  }
  return body;
}
