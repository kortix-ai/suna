import { loadAuth, loadAuthForHost } from '../api/auth.ts';
import { ApiError, clientFromAuth } from '../api/client.ts';
import {
  activeAccount,
  activeHostName,
  configFilePath,
  defaultProject,
  hasEnvTokenHost,
  listHosts,
} from '../api/config.ts';
import type { MeResponse } from '../api/types.ts';
import { emitJson, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { isKortixProject, linkFilePath, loadLink } from '../project-link.ts';
import { C, help, status } from '../style.ts';

// Mirrors the fallback in index.ts — the compiled binary injects the real
// version via KORTIX_CLI_VERSION; importing it back from index.ts is circular.
const VERSION = process.env.KORTIX_CLI_VERSION ?? 'dev';

const HELP = help`Usage: kortix dump [options]

Print a redacted, copy-pasteable debug summary — CLI version, runtime,
active host/account/project, auth presence, and config file locations.
Safe to paste into a support thread: no secret values are ever printed.

Options:
  --host <name>   Probe a specific host instead of the active one.
  --offline       Skip the network identity probe (pure local info).
  --json          Machine-readable JSON output.
  -h, --help      Show this help.
`;

interface DumpFlags {
  host?: string;
  offline: boolean;
  json: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): DumpFlags {
  const rest = [...argv];
  const help = takeFlagBool(rest, ['-h', '--help']);
  const offline = takeFlagBool(rest, ['--offline']);
  const json = takeFlagBool(rest, ['--json']);
  const host = takeFlagValue(rest, ['--host']);
  if (rest.length > 0) throw new Error(`unknown option "${rest[0]}"`);
  return { host, offline, json, help };
}

function runtimeLabel(): string {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? `bun ${bun}` : `node ${process.version}`;
}

export async function runDump(argv: string[]): Promise<number> {
  let flags: DumpFlags;
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

  // Local facts first — a debug dump must work with no login and no project.
  const auth = flags.host ? loadAuthForHost(flags.host) : loadAuth();
  const hostName = flags.host ?? activeHostName();
  const account = flags.host ? null : activeAccount();
  const def = flags.host ? null : defaultProject();
  const link = isKortixProject() ? loadLink() : null;
  const loggedIn = Boolean(auth?.token);

  const project = link
    ? { project_id: link.project_id, source: 'linked' as const, host: link.host ?? null }
    : def
      ? { project_id: def.project_id, source: 'default' as const, name: def.name ?? null }
      : null;

  let probe:
    | { ok: true; latency_ms: number; verified_email: string | null }
    | { ok: false; latency_ms: number; error: string }
    | null = null;

  // Best-effort reachability check — never fatal, never blocks the report.
  if (!flags.offline && auth?.token) {
    const started = Date.now();
    try {
      const me = await clientFromAuth(auth).get<MeResponse>('/accounts/me');
      probe = { ok: true, latency_ms: Date.now() - started, verified_email: me.email || null };
    } catch (err) {
      const error =
        err instanceof ApiError ? `HTTP ${err.status}: ${err.message}` : (err as Error).message;
      probe = { ok: false, latency_ms: Date.now() - started, error };
    }
  }

  const report = {
    cli_version: VERSION,
    runtime: runtimeLabel(),
    platform: `${process.platform}/${process.arch}`,
    config_file: configFilePath(),
    link_file: link ? linkFilePath() : null,
    host: {
      name: hostName,
      url: auth?.api_base ?? null,
      total_configured: listHosts().length,
      via_sandbox_env_token: hasEnvTokenHost(),
    },
    auth: {
      logged_in: loggedIn,
      user_id: auth?.user_id || null,
      user_email: auth?.user_email || null,
    },
    account: account ? { id: account.id, slug: account.slug, name: account.name || null } : null,
    project,
    identity_probe: probe,
  };

  if (flags.json) {
    emitJson(report);
    return 0;
  }

  const out: string[] = [
    '',
    `  ${C.white}${C.bold}kortix dump${C.reset}  ${C.faded}v${VERSION}${C.reset}`,
    '',
  ];
  out.push(
    `  ${C.dim}platform  ${C.reset}${report.platform} ${C.faded}(${report.runtime})${C.reset}`,
  );
  out.push(`  ${C.dim}config    ${C.reset}${report.config_file}`);
  if (report.link_file) out.push(`  ${C.dim}link file ${C.reset}${report.link_file}`);
  out.push('');
  out.push(
    `  ${C.dim}host      ${C.reset}${hostName ?? '—'} ${C.faded}(${report.host.url ?? 'no url'})${C.reset}`,
  );
  out.push(
    loggedIn
      ? status.ok(`logged in${auth?.user_email ? ` as ${auth.user_email}` : ''}`)
      : status.warn('not logged in'),
  );
  if (account) {
    out.push(`  ${C.dim}account   ${C.reset}${account.name || account.slug}`);
  }
  out.push(
    project
      ? `  ${C.dim}project   ${C.reset}${project.project_id} ${C.faded}(${project.source})${C.reset}`
      : `  ${C.dim}project   ${C.reset}${C.faded}none${C.reset}`,
  );
  if (probe) {
    out.push(
      probe.ok
        ? status.ok(`API reachable (${probe.latency_ms}ms)`)
        : status.err(`API probe failed (${probe.latency_ms}ms): ${probe.error}`),
    );
  }
  if (report.host.total_configured > 1) {
    out.push(`  ${C.dim}hosts     ${C.reset}${report.host.total_configured} configured`);
  }
  out.push('');
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}
