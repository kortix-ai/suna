import {
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
} from '../command-helpers.ts';
import { ApiError } from '../api/client.ts';
import { C, status } from '../style.ts';
import type { ProjectSession } from '../api/types.ts';

const HELP = `Usage: kortix proxy <subcommand> [options]

Manage shareable public URLs for ports inside a session sandbox. Use
this to expose a dev server (port 3000, 8080, …) running inside a
session to anyone who has the link — agents, teammates, demos.

Subcommands:
  share <session-id> --port <N>      Create a public URL for <port>.
        [--ttl <duration>]            ttl examples: "1h", "7d", "permanent"
        [--label "<text>"]            Optional label for your records.
  ls <session-id>                    List active share links.
  rm <session-id> <token>            Revoke a share link.

Global options:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.
`;

type CtxOpts = { projectArg?: string; hostArg?: string };

export async function runProxy(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let portFlag: string | undefined;
  let ttlFlag: string | undefined;
  let labelFlag: string | undefined;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    portFlag = takeFlagValue(rest, ['--port', '-p']);
    ttlFlag = takeFlagValue(rest, ['--ttl']);
    labelFlag = takeFlagValue(rest, ['--label']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts: CtxOpts = { projectArg: projectFlag, hostArg: hostFlag };

  switch (sub) {
    case 'share':
    case 'new':
    case 'create':
      return proxyShare(rest[0], portFlag, ttlFlag, labelFlag, ctxOpts);
    case 'ls':
    case 'list':
      return proxyLs(rest[0], ctxOpts);
    case 'rm':
    case 'revoke':
    case 'delete':
      return proxyRm(rest[0], rest[1], ctxOpts);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

async function resolveSandboxId(
  sessionId: string | undefined,
  ctx: NonNullable<ReturnType<typeof resolveProjectContext>>,
): Promise<string | null> {
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n`);
    return null;
  }
  let session: ProjectSession;
  try {
    session = await ctx.client.get<ProjectSession>(
      `/projects/${ctx.projectId}/sessions/${sessionId}`,
    );
  } catch (err) {
    surfaceApiError(err);
    return null;
  }
  if (!session.sandbox_id) {
    process.stderr.write(`${status.err('Session has no sandbox_id yet.')}\n`);
    return null;
  }
  return session.sandbox_id;
}

async function proxyShare(
  sessionId: string | undefined,
  portStr: string | undefined,
  ttl: string | undefined,
  label: string | undefined,
  opts: CtxOpts,
): Promise<number> {
  if (!portStr) {
    process.stderr.write(`${status.err('Pass --port <N>.')}\n`);
    return 2;
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`${status.err('--port must be 1-65535.')}\n`);
    return 2;
  }

  const ctx = resolveProjectContext(opts);
  if (!ctx) return 1;
  const sandboxId = await resolveSandboxId(sessionId, ctx);
  if (!sandboxId) return 1;

  const body: Record<string, unknown> = { sandbox_id: sandboxId, port };
  if (ttl) body.ttl = ttl;
  if (label) body.label = label;

  let resp: Record<string, unknown>;
  try {
    resp = await ctx.client.post<Record<string, unknown>>('/p/share', body);
  } catch (err) {
    return surfaceApiError(err);
  }

  process.stdout.write('\n');
  const url = pickString(resp, ['url', 'share_url', 'public_url']);
  const token = pickString(resp, ['token', 'share_token']);
  if (url) {
    process.stdout.write(`${status.ok(`Public URL`)}\n  ${C.cyan}${url}${C.reset}\n`);
  }
  if (token) process.stdout.write(`  ${C.dim}token  ${C.reset}${token}\n`);
  process.stdout.write(`  ${C.dim}port   ${C.reset}${port}\n`);
  if (label) process.stdout.write(`  ${C.dim}label  ${C.reset}${label}\n`);
  if (ttl) process.stdout.write(`  ${C.dim}ttl    ${C.reset}${ttl}\n`);
  if (!url && !token) {
    // Fallback: dump whatever the sandbox returned.
    process.stdout.write(`  ${C.dim}response${C.reset}\n${JSON.stringify(resp, null, 2)}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

async function proxyLs(sessionId: string | undefined, opts: CtxOpts): Promise<number> {
  const ctx = resolveProjectContext(opts);
  if (!ctx) return 1;
  const sandboxId = await resolveSandboxId(sessionId, ctx);
  if (!sandboxId) return 1;

  let resp: Record<string, unknown>;
  try {
    resp = await ctx.client.get<Record<string, unknown>>(
      `/p/share?sandbox_id=${encodeURIComponent(sandboxId)}`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  // Try a few possible array shapes from the sandbox.
  const items =
    (resp.items as Array<Record<string, unknown>> | undefined) ??
    (resp.shares as Array<Record<string, unknown>> | undefined) ??
    (Array.isArray(resp) ? (resp as unknown as Array<Record<string, unknown>>) : null);

  if (!items || items.length === 0) {
    process.stdout.write(
      `  ${C.dim}No active share links. Create one with \`kortix proxy share ${sessionId} --port 3000\`.${C.reset}\n`,
    );
    return 0;
  }

  process.stdout.write('\n');
  for (const it of items) {
    const port = it.port;
    const url = pickString(it, ['url', 'share_url', 'public_url']);
    const token = pickString(it, ['token', 'share_token']);
    const label = pickString(it, ['label']);
    process.stdout.write(`  ${C.bold}port ${port ?? '?'}${C.reset}`);
    if (label) process.stdout.write(`  ${C.dim}— ${label}${C.reset}`);
    process.stdout.write('\n');
    if (url) process.stdout.write(`  ${C.cyan}${url}${C.reset}\n`);
    if (token) process.stdout.write(`  ${C.dim}token ${C.reset}${token}\n`);
    process.stdout.write('\n');
  }
  return 0;
}

async function proxyRm(
  sessionId: string | undefined,
  token: string | undefined,
  opts: CtxOpts,
): Promise<number> {
  if (!token) {
    process.stderr.write(`${status.err('Pass the share token.')}\n`);
    return 2;
  }
  const ctx = resolveProjectContext(opts);
  if (!ctx) return 1;
  const sandboxId = await resolveSandboxId(sessionId, ctx);
  if (!sandboxId) return 1;

  try {
    await ctx.client.delete(
      `/p/share/${encodeURIComponent(token)}?sandbox_id=${encodeURIComponent(sandboxId)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      process.stderr.write(`${status.err('Share token not found.')}\n`);
      return 1;
    }
    return surfaceApiError(err);
  }
  process.stdout.write(`${status.ok(`Revoked share link`)}\n`);
  return 0;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}
