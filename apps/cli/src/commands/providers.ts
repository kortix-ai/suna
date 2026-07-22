import { createInterface } from 'node:readline';

import { CATALOG, isProviderAuthSatisfied, primaryAuthEnvVars } from '@kortix/llm-catalog';
import {
  type AuthFlow,
  type AuthProviderPublic,
  accountDoorProviders,
  findAuthProviderPublic,
} from '@kortix/shared/auth-providers';
import { HARNESSES, type HarnessId, compatibleHarnessesFor } from '@kortix/shared/harnesses';

import { type ApiClient, ApiError } from '../api/client.ts';
import type {
  AuthProvidersResponse,
  OauthFlowStartResponse,
  OauthPollResponse,
  ProjectSecret,
} from '../api/types.ts';
import { openInBrowser } from '../browser.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

const HELP = help`Usage: kortix providers <subcommand> [options]

Connect LLM credentials to the linked Kortix project. Two doors, one registry
(the same one the web dashboard reads — docs/specs/2026-07-22-unified-auth-
gateway.md):

  • Account — sign in with a subscription. Codex/ChatGPT uses a device-code
    flow; Claude Code pastes a \`claude setup-token\`. Tokens land encrypted
    on the project and are refreshed on each sandbox boot.

  • API key — stored as an encrypted project secret, injected into sessions
    at boot. One key can unlock several harnesses (an Anthropic key serves
    Claude Code, OpenCode, and Pi).

Subcommands:
  ls [--json]                       List every provider door with its live
                                    status and which harnesses it unlocks.
  login <provider>                  Connect an account (subscription).
                                    Providers: openai (alias codex),
                                    claude (alias for anthropic's subscription).
  set <provider> [<key>]            Save an API key as a project secret.
                                    With no <key>, reads from stdin.
                                    bedrock also needs --region <region>.
  rm <provider>                     Disconnect an account and/or remove the
                                    matching API-key secret(s).

Account providers (subscription sign-in):
  openai / codex     ChatGPT / Codex — device-code flow
  claude / anthropic Claude Code — paste a \`claude setup-token\`

Known API-key providers (provider → project secret(s)):
  anthropic       → ANTHROPIC_API_KEY
  openai          → OPENAI_API_KEY
  openrouter      → OPENROUTER_API_KEY
  google          → GOOGLE_GENERATIVE_AI_API_KEY
  groq            → GROQ_API_KEY
  xai             → XAI_API_KEY
  deepseek        → DEEPSEEK_API_KEY
  mistral         → MISTRAL_API_KEY
  bedrock         → AWS_BEARER_TOKEN_BEDROCK + AWS_REGION (--region)

Global options:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  --region <region>  (set bedrock) AWS region, e.g. us-east-1.
  -h, --help         Show this help.
`;

// ── provider → required project-secret(s) for the API-key flow ────────────
// Sourced from @kortix/llm-catalog's Kortix-owned auth requirement — NOT the
// raw models.dev env list, which for some providers (Bedrock) includes an
// auth method (SigV4 access keys) Kortix's transport doesn't implement. See
// packages/llm-catalog/src/auth-requirements.ts for the full rationale; this
// is the single declaration the web connect modal, the connected-provider
// gate, and this CLI all derive from, so they can't drift.
//
// Every provider here has exactly one required method today. All but bedrock
// need one secret (`set <provider> <key>`); bedrock needs two (bearer token
// + region), handled specially in providersSet/providersRm below.
export const PROVIDER_CATALOG_ID: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  openrouter: 'openrouter',
  google: 'google',
  groq: 'groq',
  xai: 'xai',
  deepseek: 'deepseek',
  mistral: 'mistral',
  bedrock: 'amazon-bedrock',
};

export const PROVIDER_ENV_VARS: Record<string, string[]> = Object.fromEntries(
  Object.entries(PROVIDER_CATALOG_ID).map(([cliName, catalogId]) => {
    const catalogProvider = CATALOG.providers.find((p) => p.id === catalogId);
    return [cliName, catalogProvider ? primaryAuthEnvVars(catalogProvider) : []];
  }),
);

/** ANY-OF-methods (single method for every CLI-known provider today), ALL-
 *  OF-vars-within-it — same predicate `use-connected-providers.ts` uses in
 *  the web modal, so `providers ls` never disagrees with it. */
export function isProviderConnected(envVars: string[], secretNames: Set<string>): boolean {
  return (
    envVars.length > 0 &&
    isProviderAuthSatisfied({ methods: [{ envVars }] }, (v) => secretNames.has(v))
  );
}

// ── Account-door resolution — registry-driven, no hardcoded provider set ────
// The old `OAUTH_PROVIDERS = new Set(['openai'])` is gone: which providers
// offer an account/subscription door is now read from the shared registry
// (`@kortix/shared/auth-providers`), the SAME table the web reads (spec §8.3),
// so the CLI and web can never drift on it again.

/** CLI-friendly aliases → the registry account-door provider id. `codex`/
 *  `chatgpt` are the honest names for OpenAI's SUBSCRIPTION door (it unlocks
 *  the Codex harness, not a generic OpenAI-brand OAuth); `claude` names
 *  Anthropic's subscription door specifically (vs. the `anthropic` API key). */
const ACCOUNT_ALIASES: Record<string, string> = {
  claude: 'anthropic',
  'claude-code': 'anthropic',
  codex: 'openai',
  chatgpt: 'openai',
};

/** The flows this CLI build can actually complete. `browser-oauth` is NOT
 *  here: the local-callback browser sign-in the registry lists first for
 *  Codex (spec §6.2) needs a server-side direct-store route AND the server-
 *  only `OAuthClientConfig` — neither is shipped in the landed Step-3 backend,
 *  so the CLI falls through to the next flow (device-code) instead. See the
 *  task report for the deferral rationale. */
const CLI_SUPPORTED_FLOWS: ReadonlySet<AuthFlow> = new Set(['device-code', 'paste-token']);

/** Account-door secret names for paste-token providers — mirrors the server's
 *  `accountSecretName()` in apps/api/.../routes/auth-providers.ts (the source
 *  of truth). Only `claude_subscription` is paste-token today. */
const ACCOUNT_PASTE_SECRET_BY_KIND: Record<string, string> = {
  claude_subscription: 'CLAUDE_CODE_OAUTH_TOKEN',
};

/** Resolve a user-typed provider name to a registry account-door entry,
 *  honouring the friendly aliases. `undefined` if it names no account door. */
function resolveAccountProvider(input: string): AuthProviderPublic | undefined {
  const direct = findAuthProviderPublic(input, 'account');
  if (direct) return direct;
  const aliased = ACCOUNT_ALIASES[input];
  return aliased ? findAuthProviderPublic(aliased, 'account') : undefined;
}

/** Pick the flow the CLI will actually run for an account provider, skipping
 *  gated flows (Anthropic one-click, off by default) and flows this build
 *  can't complete (`browser-oauth`). Returns the chosen flow plus whether a
 *  preferred-but-unavailable browser flow was skipped, so `login` can say so. */
function chooseCliFlow(entry: AuthProviderPublic): {
  flow: AuthFlow | null;
  browserSkipped: 'gated' | 'unsupported' | null;
} {
  let browserSkipped: 'gated' | 'unsupported' | null = null;
  for (const flow of entry.flows.cli) {
    if (flow === 'browser-oauth') {
      // Registry may list browser-oauth first; skip it and remember why.
      browserSkipped = entry.gatedBehind ? 'gated' : 'unsupported';
      continue;
    }
    if (CLI_SUPPORTED_FLOWS.has(flow)) return { flow, browserSkipped };
  }
  return { flow: null, browserSkipped };
}

/** "Claude Code, OpenCode, Pi" from a HarnessAuthKind — the unlocks copy. */
function unlocksLabels(harnessIds: readonly string[]): string {
  const labels = harnessIds
    .map((id) => HARNESSES[id as HarnessId]?.label ?? id)
    .filter((l): l is string => Boolean(l));
  return labels.length > 0 ? labels.join(', ') : '—';
}

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
  let regionFlag: string | undefined;
  let json = false;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    regionFlag = takeFlagValue(rest, ['--region']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts: CtxOpts = { projectArg: projectFlag, hostArg: hostFlag };

  switch (sub) {
    case 'ls':
    case 'list':
      return providersLs(ctxOpts, json);
    case 'login':
    case 'oauth':
      return providersLogin(rest[0], ctxOpts);
    case 'set':
      return providersSet(rest[0], rest[1], regionFlag, ctxOpts);
    case 'rm':
    case 'remove':
    case 'unset':
      return providersRm(rest[0], ctxOpts);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

// ── ls ──────────────────────────────────────────────────────────────────────

/** Map the server's `CredentialStatus` onto the ONE status vocabulary the web
 *  uses (connection-status.ts) so a credential reads the same word on every
 *  surface. `absent`/null → "Not connected". */
function statusWord(status: string | null | undefined): { text: string; color: string } {
  switch (status) {
    case 'healthy':
      return { text: 'Connected', color: C.green };
    case 'expired':
      return { text: 'Expired', color: C.red };
    case 'invalid':
      return { text: 'Needs attention', color: C.red };
    case 'unverified':
      return { text: 'Checking', color: C.yellow };
    default:
      return { text: 'Not connected', color: C.dim };
  }
}

async function providersLs(opts: CtxOpts, json = false): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let providers: AuthProvidersResponse;
  let secrets: { items: ProjectSecret[] };
  try {
    [providers, secrets] = await Promise.all([
      ctx.client.get<AuthProvidersResponse>(`/projects/${ctx.projectId}/auth-providers`),
      ctx.client.get<{ items: ProjectSecret[] }>(`/projects/${ctx.projectId}/secrets`),
    ]);
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson({ providers: providers.providers, byok: providers.byok, secrets: secrets.items });
    return 0;
  }

  const accountRows = providers.providers.filter((p) => p.door === 'account');
  const apiKeyRows = providers.providers.filter(
    (p) => p.door === 'api-key' && (p.compatibleHarnesses.length > 0 || p.status),
  );

  process.stdout.write('\n');

  // ── Accounts door ──
  if (accountRows.length > 0) {
    process.stdout.write(
      `  ${C.bold}Accounts${C.reset}  ${C.dim}(subscription sign-in)${C.reset}\n`,
    );
    const nameW = Math.max(...accountRows.map((r) => r.label.length), 14);
    process.stdout.write(
      `  ${C.dim}${pad('PROVIDER', nameW)}   ${pad('STATUS', 15)}  ${pad('UNLOCKS', 22)}  EXPIRES${C.reset}\n`,
    );
    for (const row of accountRows) {
      const sw = statusWord(row.status?.status);
      const unlocks = unlocksLabels(row.compatibleHarnesses);
      // `gated` only marks the off-by-default browser one-click (Anthropic) —
      // the provider is still connectable via its default flow, so it must not
      // read as an expiry/availability signal here.
      const exp =
        row.status?.expiresAt != null ? formatDuration(row.status.expiresAt - Date.now()) : '—';
      process.stdout.write(
        `  ${pad(row.label, nameW)}   ${sw.color}${pad(sw.text, 15)}${C.reset}  ${pad(unlocks, 22)}  ${C.faded}${exp}${C.reset}\n`,
      );
    }
    process.stdout.write('\n');
  }

  // ── API-key door ── (registry entries with a real harness set, + connected BYOK)
  const setSecretNames = new Set(secrets.items.map((s) => s.name));
  const byokConnected = providers.byok.filter((b) =>
    isProviderConnected(b.apiKeyEnvVars, setSecretNames),
  );

  if (apiKeyRows.length > 0 || byokConnected.length > 0) {
    process.stdout.write(`  ${C.bold}API keys${C.reset}\n`);
    const nameW = Math.max(
      ...apiKeyRows.map((r) => r.label.length),
      ...byokConnected.map((b) => b.label.length),
      14,
    );
    process.stdout.write(
      `  ${C.dim}${pad('PROVIDER', nameW)}   ${pad('STATUS', 15)}  UNLOCKS${C.reset}\n`,
    );
    for (const row of apiKeyRows) {
      const sw = statusWord(row.status?.status);
      process.stdout.write(
        `  ${pad(row.label, nameW)}   ${sw.color}${pad(sw.text, 15)}${C.reset}  ${unlocksLabels(row.compatibleHarnesses)}\n`,
      );
    }
    for (const b of byokConnected) {
      process.stdout.write(
        `  ${pad(b.label, nameW)}   ${C.green}${pad('Connected', 15)}${C.reset}  ${C.dim}${b.apiKeyEnvVars.join(' + ')}${C.reset}\n`,
      );
    }
    process.stdout.write('\n');
  }

  const nothingConnected =
    accountRows.every((r) => !r.status || r.status.status === 'absent') &&
    apiKeyRows.every((r) => !r.status || r.status.status === 'absent') &&
    byokConnected.length === 0;
  if (nothingConnected) {
    process.stdout.write(
      `  ${C.dim}Nothing connected yet. Try:${C.reset}\n` +
        `    ${C.cyan}kortix providers login codex${C.reset}     ${C.dim}(ChatGPT/Codex subscription)${C.reset}\n` +
        `    ${C.cyan}kortix providers login claude${C.reset}    ${C.dim}(Claude setup-token)${C.reset}\n` +
        `    ${C.cyan}kortix providers set anthropic sk-ant-...${C.reset}\n\n`,
    );
  }

  return 0;
}

// ── login ───────────────────────────────────────────────────────────────────

async function providersLogin(provider: string | undefined, opts: CtxOpts): Promise<number> {
  if (!provider) {
    process.stderr.write(
      `${status.err('Pass a provider: kortix providers login <codex|claude>')}\n`,
    );
    return 2;
  }

  const entry = resolveAccountProvider(provider);
  if (!entry) {
    if (PROVIDER_ENV_VARS[provider]?.length) {
      process.stderr.write(
        `${status.err(`"${provider}" connects via an API key, not an account sign-in.`)}\n` +
          `  ${C.dim}Run ${C.reset}${C.cyan}kortix providers set ${provider} <key>${C.reset}${C.dim} instead.${C.reset}\n`,
      );
    } else {
      const accountNames = accountDoorProviders().map((p) => p.id);
      process.stderr.write(
        `${status.err(`"${provider}" isn't an account provider.`)}\n` +
          `  ${C.dim}Account sign-in: ${accountNames.join(', ')} (aliases: ${Object.keys(ACCOUNT_ALIASES).join(', ')}).${C.reset}\n` +
          `  ${C.dim}Or connect an API key: ${C.reset}${C.cyan}kortix providers set <provider> <key>${C.reset}\n`,
      );
    }
    return 2;
  }

  const { flow, browserSkipped } = chooseCliFlow(entry);
  if (!flow) {
    process.stderr.write(
      `${status.err(`No usable sign-in flow for ${entry.label} in this CLI build.`)}\n` +
        `  ${C.dim}The registry lists it, but every flow is gated or unsupported here.${C.reset}\n`,
    );
    return 1;
  }
  // Note when a browser flow was the registry's first choice but we skipped it.
  if (browserSkipped === 'unsupported') {
    process.stdout.write(
      `  ${C.dim}Browser sign-in isn't available in this CLI build yet — using device code.${C.reset}\n`,
    );
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  const unlocks = unlocksLabels(compatibleHarnessesFor(entry.producesAuthKind));

  if (flow === 'paste-token') {
    return loginPasteToken(entry, ctx, unlocks);
  }
  return loginDeviceCode(entry, ctx, unlocks);
}

/** Device-code flow (Codex today) — start + poll against the unified
 *  /oauth-credentials routes. Any replica can serve the poll: the flow state
 *  round-trips through an opaque encrypted handle. */
async function loginDeviceCode(
  entry: AuthProviderPublic,
  ctx: { client: ApiClient; projectId: string },
  unlocks: string,
): Promise<number> {
  let flow: OauthFlowStartResponse;
  try {
    flow = await ctx.client.post<OauthFlowStartResponse>(
      `/projects/${ctx.projectId}/oauth-credentials/${entry.id}/start`,
      {},
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  process.stdout.write(
    `\n  ${C.bold}Connect ${entry.label}${C.reset}\n` +
      `  ${C.dim}Open this URL and enter the code:${C.reset}\n` +
      `    ${C.cyan}${flow.verification_url}${C.reset}\n` +
      `    code: ${C.bold}${flow.user_code}${C.reset}\n` +
      `  ${C.dim}Waiting for approval (Ctrl+C to cancel)…${C.reset}\n`,
  );
  openInBrowser(flow.verification_url);

  const deadline = flow.expires_at;
  let intervalMs = flow.interval_ms || 5000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let resp: OauthPollResponse;
    try {
      resp = await ctx.client.post<OauthPollResponse>(
        `/projects/${ctx.projectId}/oauth-credentials/${entry.id}/poll`,
        { flow_id: flow.flow_id },
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) continue;
      return surfaceApiError(err);
    }
    if (resp.status === 'success') {
      process.stdout.write(
        `\n${status.ok(`Connected ${C.bold}${entry.label}${C.reset} on this project`)}\n` +
          `  ${C.dim}Unlocks: ${unlocks}${C.reset}\n`,
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

/** Paste-token flow (Claude Code) — Anthropic's policy forbids third-party
 *  browser relay of a subscription, so its sanctioned path is a `claude
 *  setup-token` paste written straight to project secrets (spec §6.6(2)). */
async function loginPasteToken(
  entry: AuthProviderPublic,
  ctx: { client: ApiClient; projectId: string },
  unlocks: string,
): Promise<number> {
  const secretName = ACCOUNT_PASTE_SECRET_BY_KIND[entry.producesAuthKind];
  if (!secretName) {
    process.stderr.write(
      `${status.err(`No paste target known for ${entry.label} (${entry.producesAuthKind}).`)}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `\n  ${C.bold}Connect ${entry.label}${C.reset}\n` +
      `  ${C.dim}Claude Code uses Anthropic's own browser sign-in, not a device code.${C.reset}\n` +
      `  ${C.dim}On your machine, run:${C.reset}\n` +
      `    ${C.cyan}claude setup-token${C.reset}\n` +
      `  ${C.dim}then paste the token it prints below.${C.reset}\n`,
  );
  const token = await readSecret('  Token (input hidden): ');
  if (!token) {
    process.stderr.write(`${status.err('Empty token — aborting.')}\n`);
    return 1;
  }

  try {
    await ctx.client.post<ProjectSecret>(`/projects/${ctx.projectId}/secrets`, {
      name: secretName,
      value: token,
    });
  } catch (err) {
    return surfaceApiError(err);
  }

  process.stdout.write(
    `\n${status.ok(`Connected ${C.bold}${entry.label}${C.reset} on this project`)}\n` +
      `  ${C.dim}Unlocks: ${unlocks}${C.reset}\n` +
      `  ${C.dim}Stored as ${secretName}; injected on the next sandbox boot.${C.reset}\n\n`,
  );
  return 0;
}

// ── set ─────────────────────────────────────────────────────────────────────

async function providersSet(
  provider: string | undefined,
  key: string | undefined,
  regionFlag: string | undefined,
  opts: CtxOpts,
): Promise<number> {
  if (!provider) {
    process.stderr.write(
      `${status.err('Pass a provider: kortix providers set <provider> [<key>]')}\n`,
    );
    return 2;
  }
  const envVars = PROVIDER_ENV_VARS[provider];
  if (!envVars || envVars.length === 0) {
    process.stderr.write(
      `${status.err(`Unknown provider "${provider}".`)}\n` +
        `  ${C.dim}Known: ${Object.keys(PROVIDER_ENV_VARS).join(', ')}${C.reset}\n` +
        `  ${C.dim}Or set a custom env directly: \`kortix secrets set NAME=value\`${C.reset}\n`,
    );
    return 2;
  }

  // bedrock is the one provider needing two values (bearer token + region) —
  // every other provider stays the plain single-key flow below.
  const values: Record<string, string> = {};
  if (envVars.length === 1) {
    const envVar = envVars[0]!;
    const value = key || (await readSecret(`Enter ${envVar} (input hidden): `));
    if (!value) {
      process.stderr.write(`${status.err('Empty value — aborting.')}\n`);
      return 1;
    }
    values[envVar] = value;
  } else {
    const [tokenVar, regionVar] = envVars; // ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']
    const token = key || (await readSecret(`Enter ${tokenVar} (input hidden): `));
    if (!token) {
      process.stderr.write(`${status.err('Empty value — aborting.')}\n`);
      return 1;
    }
    let region = regionFlag;
    if (!region && process.stdin.isTTY) {
      region = await readVisible(`Enter ${regionVar} (e.g. us-east-1): `);
    }
    if (!region) {
      process.stderr.write(
        `${status.err(`${provider} also needs a region: pass --region <region>.`)}\n` +
          `  ${C.dim}Example: kortix providers set bedrock <token> --region us-east-1${C.reset}\n`,
      );
      return 2;
    }
    values[tokenVar!] = token;
    values[regionVar!] = region;
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  try {
    for (const [name, value] of Object.entries(values)) {
      await ctx.client.post<ProjectSecret>(`/projects/${ctx.projectId}/secrets`, { name, value });
    }
  } catch (err) {
    return surfaceApiError(err);
  }

  // "Unlocks" — the many-to-many credential→harness set, derived from the same
  // catalog id the api-key door maps onto. Only the two catalog providers that
  // gate a real HarnessAuthKind (anthropic/openai) have a meaningful set today.
  const unlocks = unlocksForApiKeyProvider(provider);
  const unlocksLine = unlocks ? `  ${C.dim}Unlocks: ${unlocks}${C.reset}\n` : '';
  process.stdout.write(
    `\n${status.ok(`Saved ${C.bold}${Object.keys(values).join(', ')}${C.reset} for ${C.bold}${provider}${C.reset}`)}\n${unlocksLine}  ${C.dim}Will be injected on the next sandbox boot.${C.reset}\n\n`,
  );
  return 0;
}

/** The harness set an API-key provider unlocks, or `null` when the CLI can't
 *  name it (a plain BYOK key that only widens the gateway catalog, not a
 *  distinct HarnessAuthKind). Only the two catalog providers that gate a real
 *  kind (anthropic/openai) have one today — the api-key doors live in the
 *  server registry, not the public account-only table, so resolve by kind. */
function unlocksForApiKeyProvider(provider: string): string | null {
  const catalogId = PROVIDER_CATALOG_ID[provider] ?? provider;
  if (catalogId === 'anthropic') return unlocksLabels(compatibleHarnessesFor('anthropic_api_key'));
  if (catalogId === 'openai') return unlocksLabels(compatibleHarnessesFor('openai_api_key'));
  return null;
}

// ── rm ──────────────────────────────────────────────────────────────────────

async function providersRm(provider: string | undefined, opts: CtxOpts): Promise<number> {
  if (!provider) {
    process.stderr.write(`${status.err('Pass a provider.')}\n`);
    return 2;
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  const isAlias = provider in ACCOUNT_ALIASES;
  const accountEntry = resolveAccountProvider(provider);
  // An alias (claude/codex) targets the account door only; a bare provider
  // name (anthropic/openai/openrouter) removes everything for that provider.
  const envVars = isAlias ? [] : (PROVIDER_ENV_VARS[provider] ?? []);

  let removedAccount = false;
  const removedKeys: string[] = [];

  if (accountEntry) {
    try {
      await ctx.client.delete(`/projects/${ctx.projectId}/oauth-credentials/${accountEntry.id}`);
      removedAccount = true;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) {
        return surfaceApiError(err);
      }
    }
  }

  for (const envVar of envVars) {
    try {
      await ctx.client.delete(`/projects/${ctx.projectId}/secrets/${envVar}`);
      removedKeys.push(envVar);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) {
        return surfaceApiError(err);
      }
    }
  }

  if (!removedAccount && removedKeys.length === 0) {
    process.stdout.write(`  ${C.dim}Nothing to remove for "${provider}".${C.reset}\n`);
    return 0;
  }
  const parts: string[] = [];
  if (removedAccount) parts.push('account credential');
  if (removedKeys.length > 0)
    parts.push(`secret${removedKeys.length > 1 ? 's' : ''} ${removedKeys.join(', ')}`);
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

/** Read a plain (non-secret) value with normal echoed input — e.g. a region,
 *  which isn't sensitive and is easier to verify visibly. */
async function readVisible(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(label, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Read a secret with input echo suppressed when possible. Falls back to
 *  normal readline (echoed) if stdin is not a TTY. */
async function readSecret(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const wasMuted = rl as unknown as { _writeToOutput?: unknown };
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
