import type { WorkspaceSession } from '@kortix/sdk';
import { loadAuth, loadAuthForHost } from '../api/auth.ts';
import { ApiError } from '../api/client.ts';
import { hasEnvTokenHost } from '../api/config.ts';
import { kortixFromAuth, unwrapRuntime, withKortixScope } from '../api/sdk.ts';
import type { MeResponse, WorkspaceSummary } from '../api/types.ts';
import { resolveWorkspaceContext, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { loadWorkspaceLink } from '../workspace-link.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix doctor [options]

End-to-end smoke test: confirms login → workspace resolves → optionally
spins up a throwaway session, sends a message, and asserts the agent
replies. Designed so coding agents can verify Kortix end-to-end before
they start orchestrating real work.

Options:
  --no-session         Stop after auth + workspace checks. Don't create
                       a sandbox. Fast and cheap.
  --keep-session       Don't delete the test session at the end.
  --prompt "<text>"    Test prompt (default: "ping").
  --timeout <seconds>  How long to wait for the reply (default: 180).
  --workspace <id>     Operate on this workspace (default: linked).
  --host <name>        Operate against a non-default Kortix host.
  -h, --help           Show this help.

Exit codes:
  0  All checks passed.
  1  At least one check failed.
`;

interface DoctorFlags {
  noSession: boolean;
  keepSession: boolean;
  prompt: string;
  timeoutSec: number;
  workspace?: string;
  host?: string;
  help: boolean;
}

export async function runDoctor(argv: string[]): Promise<number> {
  let flags: DoctorFlags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  process.stdout.write(`\n  ${C.bold}kortix doctor${C.reset}\n\n`);

  let failures = 0;

  // ── 1. Auth ─────────────────────────────────────────────────────────────
  const hostFromLink =
    !flags.host && !hasEnvTokenHost() ? (loadWorkspaceLink()?.host ?? undefined) : undefined;
  const hostName = flags.host ?? hostFromLink;
  const auth = hostName ? loadAuthForHost(hostName) : loadAuth();
  if (!auth?.token) {
    process.stdout.write(`${status.err('not logged in — run `kortix login`')}\n`);
    return 1;
  }
  process.stdout.write(
    `${status.ok(`logged in to ${C.bold}${hostName ?? 'default'}${C.reset} (${auth.api_base})`)}\n`,
  );

  // ── 2. /accounts/me ─────────────────────────────────────────────────────
  const ctx = await resolveWorkspaceContext({ workspaceArg: flags.workspace, hostArg: flags.host });
  if (!ctx) return 1;
  try {
    const me = await ctx.client.get<MeResponse>('/accounts/me');
    process.stdout.write(`${status.ok(`identity verified as ${C.bold}${me.email}${C.reset}`)}\n`);
  } catch (err) {
    process.stdout.write(`${status.err(`identity probe failed: ${describe(err)}`)}\n`);
    return 1;
  }

  // ── 3. Workspace ────────────────────────────────────────────────────────
  let workspace: WorkspaceSummary;
  try {
    workspace = await ctx.client.get<WorkspaceSummary>(`/workspaces/${ctx.workspaceId}`);
    process.stdout.write(
      `${status.ok(`workspace ${C.bold}${workspace.name}${C.reset} ${C.faded}(${workspace.workspace_id})${C.reset}`)}\n`,
    );
  } catch (err) {
    process.stdout.write(`${status.err(`workspace lookup failed: ${describe(err)}`)}\n`);
    return 1;
  }

  if (flags.noSession) {
    process.stdout.write(`\n${status.ok('all checks passed (no-session)')}\n\n`);
    return 0;
  }

  // ── 4. Spin up a session ────────────────────────────────────────────────
  const t0 = Date.now();
  process.stdout.write(`  ${C.dim}creating session…${C.reset}\n`);
  let session: WorkspaceSession;
  try {
    session = await withKortixScope(auth, () =>
      kortixFromAuth(auth).workspace(ctx.workspaceId).sessions.create(),
    );
  } catch (err) {
    process.stdout.write(`${status.err(`session create failed: ${describe(err)}`)}\n`);
    return 1;
  }
  const sessionId = session.session_id;
  const handle = kortixFromAuth(auth).session(ctx.workspaceId, sessionId);
  process.stdout.write(
    `${status.ok(`session ${C.bold}${shortId(sessionId)}${C.reset} created`)}\n`,
  );

  const cleanup = async () => {
    if (flags.keepSession) return;
    try {
      await withKortixScope(auth, () => handle.delete());
      process.stdout.write(`  ${C.dim}cleaned up session${C.reset}\n`);
    } catch {
      /* best effort */
    }
  };

  try {
    // ── 5. Resolve the session-scoped OpenCode runtime ──────────────────
    process.stdout.write(`  ${C.dim}waiting for sandbox to come up…${C.reset}\n`);
    let opencodeSessionId: string;
    try {
      const ready = await withKortixScope(auth, () =>
        handle.ensureReady({ readyTimeoutMs: flags.timeoutSec * 1000 }),
      );
      opencodeSessionId = ready.opencodeSessionId;
    } catch (error) {
      process.stdout.write(`${status.err(`session runtime failed: ${describe(error)}`)}\n`);
      failures += 1;
      return 1;
    }
    const provisionMs = Date.now() - t0;
    process.stdout.write(`${status.ok(`sandbox running (${(provisionMs / 1000).toFixed(1)}s)`)}\n`);
    process.stdout.write(
      `${status.ok(`opencode session ${C.faded}${opencodeSessionId}${C.reset}`)}\n`,
    );

    // ── 6. Send through the session-scoped SDK handle ────────────────────
    process.stdout.write(`  ${C.dim}prompt: "${flags.prompt}"${C.reset}\n`);
    const sendStart = Date.now();
    try {
      const reply = await withKortixScope(auth, async () =>
        unwrapRuntime(await handle.send(flags.prompt)),
      );
      const text = reply.parts
        .map((p) => ('text' in p && typeof p.text === 'string' ? p.text : ''))
        .join(' ')
        .trim();
      if (!text) {
        process.stdout.write(`${status.err('reply had no text content')}\n`);
        failures += 1;
      } else {
        const dur = ((Date.now() - sendStart) / 1000).toFixed(1);
        const preview = text.length > 80 ? `${text.slice(0, 77)}…` : text;
        process.stdout.write(`${status.ok(`reply (${dur}s) — ${C.dim}${preview}${C.reset}`)}\n`);
      }
    } catch (err) {
      process.stdout.write(`${status.err(`prompt failed: ${describe(err)}`)}\n`);
      failures += 1;
    }
  } finally {
    await cleanup();
  }

  process.stdout.write('\n');
  if (failures > 0) {
    process.stdout.write(
      `${status.err(`${failures} check${failures === 1 ? '' : 's'} failed`)}\n\n`,
    );
    return 1;
  }
  process.stdout.write(`${status.ok('all checks passed')}\n\n`);
  return 0;
}

function parseFlags(argv: string[]): DoctorFlags {
  const rest = [...argv];
  const flags: DoctorFlags = {
    noSession: false,
    keepSession: false,
    prompt: 'ping',
    timeoutSec: 180,
    help: false,
  };
  flags.help = takeFlagBool(rest, ['-h', '--help']);
  flags.noSession = takeFlagBool(rest, ['--no-session']);
  flags.keepSession = takeFlagBool(rest, ['--keep-session']);
  flags.workspace = takeFlagValue(rest, ['--workspace', '--project']);
  flags.host = takeFlagValue(rest, ['--host']);
  const p = takeFlagValue(rest, ['--prompt']);
  if (p) flags.prompt = p;
  const t = takeFlagValue(rest, ['--timeout']);
  if (t) {
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error('--timeout must be a positive number of seconds');
    flags.timeoutSec = n;
  }
  if (rest.length > 0) throw new Error(`unknown option "${rest[0]}"`);
  return flags;
}

function shortId(id: string): string {
  return id.split('-')[0] ?? id;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return `HTTP ${err.status} — ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
