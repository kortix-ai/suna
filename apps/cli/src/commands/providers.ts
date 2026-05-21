import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { ApiError } from '../api/client.ts';
import {
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';
import type {
  OauthCredentialSummary,
  OauthFlowStartResponse,
  OauthListResponse,
  OauthPollResponse,
  ProjectSecret,
} from '../api/types.ts';

const HELP = `Usage: kortix providers <subcommand> [options]

Configure LLM providers for the linked Kortix project. Two paths:

  • OAuth (zero config) — uses the upstream provider's device-code flow
    (ChatGPT Pro/Plus, GitHub Copilot). Tokens land encrypted on the
    project, get refreshed on each sandbox boot.

  • API key — stored as an encrypted project secret. Injected into
    sessions at boot, picked up by opencode's provider lookup.

Subcommands:
  ls                                List configured providers (OAuth +
                                    API-key secrets that map to known
                                    providers).
  login <provider>                  Run the OAuth device-code flow.
                                    Providers: openai, github-copilot.
  set <provider> [<key>]            Save an API key as a project secret.
                                    Provider → env-var mapping below.
                                    With no <key>, reads from stdin.
  rm <provider>                     Remove the OAuth credential and/or
                                    the matching API-key secret.

Known API-key providers (provider → env var):
  anthropic       → ANTHROPIC_API_KEY
  openai          → OPENAI_API_KEY
  openrouter      → OPENROUTER_API_KEY
  google          → GOOGLE_GENERATIVE_AI_API_KEY
  groq            → GROQ_API_KEY
  xai             → XAI_API_KEY
  deepseek        → DEEPSEEK_API_KEY
  mistral         → MISTRAL_API_KEY

Global options:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  --enterprise <url> (login github-copilot) Enterprise GHE URL.
  -h, --help         Show this help.
`;

// ── provider → env-var mapping for API-key flow ───────────────────────────
// Mirrors the env vars opencode picks up at provider resolution time.
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

// Providers that support the OAuth device-code flow.
const OAUTH_PROVIDERS = new Set(['openai', 'github-copilot']);

type CtxOpts = { projectArg?: string; hostArg?: string };

export async function runProviders(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let enterpriseFlag: string | undefined;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    enterpriseFlag = takeFlagValue(rest, ['--enterprise']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts: CtxOpts = { projectArg: projectFlag, hostArg: hostFlag };

  switch (sub) {
    case 'ls':
    case 'list':
      return providersLs(ctxOpts);
    case 'login':
    case 'oauth':
      return providersLogin(rest[0], enterpriseFlag, ctxOpts);
    case 'set':
      return providersSet(rest[0], rest[1], ctxOpts);
    case 'rm':
    case 'remove':
    case 'unset':
      return providersRm(rest[0], ctxOpts);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

async function providersLs(opts: CtxOpts): Promise<number> {
  const ctx = resolveProjectContext(opts);
  if (!ctx) return 1;

  let oauthList: OauthListResponse;
  let secrets: { items: ProjectSecret[] };
  try {
    [oauthList, secrets] = await Promise.all([
      ctx.client.get<OauthListResponse>(`/projects/${ctx.projectId}/oauth`),
      ctx.client.get<{ items: ProjectSecret[] }>(`/projects/${ctx.projectId}/secrets`),
    ]);
  } catch (err) {
    return surfaceApiError(err);
  }

  process.stdout.write('\n');
  const setSecretNames = new Set(secrets.items.map((s) => s.name));

  if (oauthList.items.length === 0 && setSecretNames.size === 0) {
    process.stdout.write(
      `  ${C.dim}No providers configured. Try:${C.reset}\n` +
        `    ${C.cyan}kortix providers login openai${C.reset}\n` +
        `    ${C.cyan}kortix providers set anthropic sk-ant-...${C.reset}\n\n`,
    );
    return 0;
  }

  if (oauthList.items.length > 0) {
    process.stdout.write(`  ${C.bold}OAuth${C.reset}\n`);
    const nameW = Math.max(...oauthList.items.map((c) => c.provider_id.length), 14);
    process.stdout.write(
      `  ${C.dim}${pad('PROVIDER', nameW)}   EXPIRES IN     UPDATED${C.reset}\n`,
    );
    for (const c of oauthList.items) {
      const expIn = c.expires_in_ms === null ? 'never' : formatDuration(c.expires_in_ms);
      const ts = formatRelative(c.updated_at);
      process.stdout.write(
        `  ${pad(c.provider_id, nameW)}   ${pad(expIn, 13)}  ${C.faded}${ts}${C.reset}\n`,
      );
    }
    process.stdout.write('\n');
  }

  const keyRows: Array<{ provider: string; env: string }> = [];
  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
    if (setSecretNames.has(envVar)) keyRows.push({ provider, env: envVar });
  }
  if (keyRows.length > 0) {
    process.stdout.write(`  ${C.bold}API keys${C.reset}\n`);
    const nameW = Math.max(...keyRows.map((r) => r.provider.length), 14);
    for (const r of keyRows) {
      process.stdout.write(
        `  ${pad(r.provider, nameW)}   ${C.dim}${r.env}${C.reset}\n`,
      );
    }
    process.stdout.write('\n');
  }

  return 0;
}

async function providersLogin(
  provider: string | undefined,
  enterpriseUrl: string | undefined,
  opts: CtxOpts,
): Promise<number> {
  if (!provider) {
    process.stderr.write(
      `${status.err('Pass a provider: kortix providers login <openai|github-copilot>')}\n`,
    );
    return 2;
  }
  if (!OAUTH_PROVIDERS.has(provider)) {
    process.stderr.write(
      `${status.err(`OAuth not supported for "${provider}".`)}\n` +
        `  ${C.dim}Try \`kortix providers set ${provider} <key>\` instead.${C.reset}\n`,
    );
    return 2;
  }
  const ctx = resolveProjectContext(opts);
  if (!ctx) return 1;

  // Kick off the device-code flow.
  let flow: OauthFlowStartResponse;
  try {
    flow = await ctx.client.post<OauthFlowStartResponse>(
      `/projects/${ctx.projectId}/oauth/${provider}/start`,
      enterpriseUrl ? { enterprise_url: enterpriseUrl } : {},
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  process.stdout.write(
    `\n  ${C.bold}Authorize ${provider}${C.reset}\n` +
      `  ${C.dim}Open this URL and enter the code:${C.reset}\n` +
      `    ${C.cyan}${flow.verification_url}${C.reset}\n` +
      `    code: ${C.bold}${flow.user_code}${C.reset}\n` +
      `  ${C.dim}Waiting for approval (Ctrl+C to cancel)…${C.reset}\n`,
  );
  openInBrowser(flow.verification_url);

  // Poll until success/failure/expiry.
  const deadline = flow.expires_at;
  let intervalMs = flow.interval_ms || 5000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let resp: OauthPollResponse;
    try {
      resp = await ctx.client.post<OauthPollResponse>(
        `/projects/${ctx.projectId}/oauth/${provider}/poll`,
        { flow_id: flow.flow_id },
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) continue;
      return surfaceApiError(err);
    }
    if (resp.status === 'success') {
      process.stdout.write(
        `\n${status.ok(`Authorized ${C.bold}${provider}${C.reset} on this project`)}\n`,
      );
      const exp = resp.credential.expires_in_ms;
      if (exp !== null) {
        process.stdout.write(
          `  ${C.dim}Token refresh in ${formatDuration(exp)} (handled by Kortix on next sandbox boot).${C.reset}\n\n`,
        );
      } else {
        process.stdout.write('\n');
      }
      return 0;
    }
    if (resp.status === 'pending') {
      intervalMs = resp.next_poll_ms || intervalMs;
      continue;
    }
    if (resp.status === 'expired') {
      process.stderr.write(`${status.err('Authorization timed out. Run the command again.')}\n`);
      return 1;
    }
    if (resp.status === 'failed') {
      process.stderr.write(`${status.err(`Authorization failed: ${resp.error}`)}\n`);
      return 1;
    }
  }
  process.stderr.write(`${status.err('Authorization deadline passed.')}\n`);
  return 1;
}

async function providersSet(
  provider: string | undefined,
  key: string | undefined,
  opts: CtxOpts,
): Promise<number> {
  if (!provider) {
    process.stderr.write(`${status.err('Pass a provider: kortix providers set <provider> [<key>]')}\n`);
    return 2;
  }
  const envVar = PROVIDER_ENV_VARS[provider];
  if (!envVar) {
    process.stderr.write(
      `${status.err(`Unknown provider "${provider}".`)}\n` +
        `  ${C.dim}Known: ${Object.keys(PROVIDER_ENV_VARS).join(', ')}${C.reset}\n` +
        `  ${C.dim}Or set a custom env directly: \`kortix secrets set NAME=value\`${C.reset}\n`,
    );
    return 2;
  }
  const ctx = resolveProjectContext(opts);
  if (!ctx) return 1;

  let value = key;
  if (!value) {
    value = await readSecret(`Enter ${envVar} (input hidden): `);
    if (!value) {
      process.stderr.write(`${status.err('Empty value — aborting.')}\n`);
      return 1;
    }
  }

  try {
    await ctx.client.post<ProjectSecret>(`/projects/${ctx.projectId}/secrets`, {
      name: envVar,
      value,
    });
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(
    `\n${status.ok(`Saved ${C.bold}${envVar}${C.reset} for ${C.bold}${provider}${C.reset}`)}\n` +
      `  ${C.dim}Will be injected on the next sandbox boot.${C.reset}\n\n`,
  );
  return 0;
}

async function providersRm(provider: string | undefined, opts: CtxOpts): Promise<number> {
  if (!provider) {
    process.stderr.write(`${status.err('Pass a provider.')}\n`);
    return 2;
  }
  const ctx = resolveProjectContext(opts);
  if (!ctx) return 1;

  let removedOauth = false;
  let removedKey = false;

  if (OAUTH_PROVIDERS.has(provider)) {
    try {
      await ctx.client.delete(`/projects/${ctx.projectId}/oauth/${provider}`);
      removedOauth = true;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) {
        return surfaceApiError(err);
      }
    }
  }

  const envVar = PROVIDER_ENV_VARS[provider];
  if (envVar) {
    try {
      await ctx.client.delete(`/projects/${ctx.projectId}/secrets/${envVar}`);
      removedKey = true;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) {
        return surfaceApiError(err);
      }
    }
  }

  if (!removedOauth && !removedKey) {
    process.stdout.write(`  ${C.dim}Nothing to remove for "${provider}".${C.reset}\n`);
    return 0;
  }
  const parts: string[] = [];
  if (removedOauth) parts.push('OAuth credential');
  if (removedKey) parts.push(`secret ${envVar}`);
  process.stdout.write(
    `${status.ok(`Removed ${parts.join(' + ')} for ${C.bold}${provider}${C.reset}`)}\n`,
  );
  return 0;
}

// ── helpers ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatDuration(ms: number): string {
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
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

function openInBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    /* user can copy the URL from stdout */
  }
}

/** Read a secret with input echo suppressed when possible. Falls back to
 *  normal readline (echoed) if stdin is not a TTY. */
async function readSecret(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const wasMuted = (rl as unknown as { _writeToOutput?: unknown });
  if (process.stdin.isTTY) {
    // Mute echo by replacing the readline output writer.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(label)) process.stdout.write(s);
      else process.stdout.write('');
    };
  }
  return new Promise((resolve) => {
    rl.question(label, (answer) => {
      // Restore writer so subsequent stdout works normally.
      if (wasMuted) {
        (rl as unknown as { _writeToOutput?: unknown })._writeToOutput = wasMuted;
      }
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}
