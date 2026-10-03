import { readFileSync } from 'node:fs';
import { splitHelp } from '../command-argv.ts';
import type { ProjectSecret, ProjectSecretsResponse } from '../api/types.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
} from '../command-helpers.ts';
import { resolveUserId } from '../iam.ts';
import { C, help, status } from '../style.ts';
import { IDENTIFIER_RE, secretsCall, secretsDelivery } from './secrets-delivery.ts';
import { secretsGrant } from './secrets-grant.ts';
import { secretsLs } from './secrets-ls.ts';

const HELP = help`Usage: kortix secrets <subcommand> [options]

Manage encrypted secrets on the linked Kortix project.

A secret has an IDENTIFIER (the name an agent's \`secrets\` grant references),
a KEY (the env var it occupies in the sandbox), and a value. Leave the
identifier blank and it defaults to the key. Set it explicitly to keep a
second credential profile under the same key.

Each secret has one EXPOSURE — can agent code read the value?

  environment  THE DEFAULT. The real value loads into the sandbox env. Required
               for a credential the code must COMPUTE with (AWS SigV4, HMAC
               webhook signing, JWT assertions, SSH/PEM keys) and for anything
               that is not HTTPS.
  enforced     EXPERIMENTAL — requires the project's \`secrets_egress\` feature
               flag (Settings → Feature flags), off by default. The env var
               holds a HANDLE, not the value. Kortix substitutes the real value
               outside the sandbox, only on the approved hosts, and rewrites any
               echo of it to [REDACTED].
  none         No sandbox presence. A Kortix service spends the value (LLM
               gateway, connector, Git), or the secret is stored and disabled.

Enforcement (enforced exposure) is EXPERIMENTAL and gated behind the
\`secrets_egress\` feature flag. When it is enabled it is ONE mechanism on every
sandbox provider, not a menu. Agent code sends the handle with its ordinary HTTP
client. \`kortix secrets call\` is the explicit door to the same hosts and the
same policy, for a request that cannot be intercepted in the sandbox.

Subcommands:
  ls                                List secrets (by identifier, → key when it
                                    differs) + manifest [env] spec. --json.
                                    JSON mirrors API fields: name, configured,
                                    available, effective_source, strategy,
                                    consumer, delivery_status, and granted.
                                    Legacy key and has_value aliases remain
                                    available. In an agent session only that
                                    agent's granted secrets are listed; a
                                    declared key outside the grant shows
                                    \`not granted\`, not \`missing\`.
  set KEY=VALUE [KEY=VALUE …]       Upsert one or more secrets. Identifier
                                    defaults to KEY. Use this whenever you
                                    HAVE the value — an agent included, when
                                    the human gave it in chat. Needs the
                                    project's secret-write permission.
                                    Use \`KEY=-\` to read VALUE from stdin.
    --identifier <id>               Store under an explicit identifier (a second
    --id <id>                       value under the same KEY). One KEY=VALUE only.
    --scope runtime|connector       runtime (default): loaded into the sandbox
                                    env. connector: server-side only, spent
                                    by the connector gateway.
  request NAME [NAME …]             Mint a link (valid 7 days) for a human to
                                    ENTER value(s) you do NOT have. Surface
                                    the URL (web: fill-in modal, Slack:
                                    tappable link). Reuse a live
                                    link across runs — do not re-mint/re-post
                                    while one is unexpired. Warns when this
                                    session's agent will not receive a name.
                                    --scope runtime|connector  --expires <min>
  sync                              Re-push secrets into sandboxes. In an agent
                                    session: pulls THIS session's secrets and
                                    grant now (the per-prompt sync, on
                                    demand). As a person: every active
                                    sandbox of the project. Use after a secret
                                    is set via the intake link, updated, or
                                    newly granted to the agent mid-session.
  delivery IDENTIFIER EXPOSURE      Set environment (default), enforced, or
                                    none. \`enforced\` is EXPERIMENTAL and needs
                                    the project's \`secrets_egress\` feature flag
                                    (Settings → Feature flags). The stored names
                                    runtime|egress|broker|denied are accepted as
                                    aliases.
    --allow-host <host>              Approved host for enforced exposure.
                                    Exact host, HTTPS. Repeat for more hosts.
                                    The host list IS the policy.
    --consumer <service>             Which Kortix service spends a none-exposure
                                    secret: llm-gateway or connector.
                                    (\`--consumer http-broker\` writes a legacy
                                    \`secrets call\`-only row; prefer enforced.)
    --inject-header <name>           Deprecated. Writes a legacy injection row
                                    that sets one header instead of
                                    substituting a handle.
    --template <value>               Deprecated. Header template containing
                                    {{secret}}. Requires --inject-header.
    --allow-method <method>          Deprecated. Legacy http-broker rows only.
    --allow-path <path>              Deprecated. Legacy http-broker rows only.
    --inject-query <name>            Deprecated. Legacy http-broker rows only.
    --inject-json <path>             Deprecated. Legacy http-broker rows only.
    --handle-prefix <prefix>         Vendor-shaped handle prefix, for an SDK
                                    that validates the credential's format.
  call IDENTIFIER URL               Send one policy-bound HTTPS request through
                                    Kortix — same hosts, same policy, same
                                    [REDACTED] on an echoed value. The explicit
                                    fallback for a request the sandbox cannot
                                    intercept, not a second way to configure a
                                    secret. Applies to enforced exposure, which
                                    is EXPERIMENTAL (\`secrets_egress\` flag).
    --method <method>                Default: GET.
    --header <name:value>            Request header. Repeat as needed.
    --data <value>                   Inline request body.
    --data-file <path>               Read the request body from a file.
    --only-me                       Only you can use the new value: directly,
                                    or in your own private sessions. See share.
  share IDENTIFIER                  Set WHO CAN USE the value (replaces it).
    --user <email|id|me>            A person. Repeat for more.
    --group <id>                    A group. Repeat for more.
    --agent <name>                  An agent of this project. It uses the
                                    value in every one of its sessions,
                                    triggers included — anyone who can run
                                    the agent can use it through the agent.
    --everyone                      Everyone in the project (the default).
                                    Shared with specific people, the value
                                    reaches only them — directly, or in their
                                    own private sessions. Never a shared
                                    session, a trigger, or another member's
                                    session. A person sets this; an agent
                                    session cannot.
  unset IDENTIFIER [IDENTIFIER …]   Remove one or more secrets (by identifier).
  grant IDENTIFIER --agent <name>   Let one agent receive this secret: merge
                                    the identifier into that agent's \`secrets\`
                                    list in kortix.yaml, adding the agent entry
                                    when the manifest omits it. The fix for a
                                    row \`ls\` reports as undeliverable.

Which agents may use a secret is governed by that agent's \`secrets\` grant in
kortix.yaml (by identifier), not a per-secret setting here. \`grant\` only ever
WIDENS one agent's list; to narrow or replace it, rewrite the whole set with
\`kortix agents scope\`. There is no \`secrets revoke\` — the API has no route
that removes a single identifier from a grant.

The first \`grant\` on a project with no \`agents:\` block writes that block. From
then on an agent the manifest does not list receives NO project secrets — the
command says so when it happens.

Global options:
  --project <id>     Operate on this project id (default: linked or
                     \$KORTIX_PROJECT_ID).
  -h, --help         Show this help.
`;

export async function runSecrets(argv: string[]): Promise<number> {
  const helpExit = splitHelp(argv, HELP);
  if (helpExit !== null) return helpExit;
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = takeFlagBool(rest, ['--json']);
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts = { projectArg: projectFlag, hostArg: hostFlag };

  switch (sub) {
    case 'ls':
    case 'list':
      return secretsLs(ctxOpts, json);
    case 'set':
      return secretsSet(rest, ctxOpts);
    case 'request':
    case 'req':
      return secretsRequest(rest, ctxOpts, json);
    case 'sync':
      return secretsSync(ctxOpts, json);
    case 'delivery':
    case 'strategy':
      return secretsDelivery(rest, ctxOpts, json);
    case 'call':
      return secretsCall(rest, ctxOpts, json);
    case 'unset':
    case 'rm':
    case 'remove':
      return secretsUnset(rest, ctxOpts);
    case 'grant':
      return secretsGrant(rest, ctxOpts, json);
    case 'share':
      return secretsShare(rest, ctxOpts, json);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

type CtxOpts = { projectArg?: string; hostArg?: string };


async function secretsSet(args: string[], opts: CtxOpts): Promise<number> {
  // An explicit identifier (--identifier / --id) keeps a second value under the
  // same KEY. It addresses exactly one secret, so it pairs with a single
  // KEY=VALUE; omit it and the identifier defaults to the KEY (the common case,
  // where any number of pairs is fine).
  let identifier: string | undefined;
  let scope: string | undefined;
  const onlyMe = takeFlagBool(args, ['--only-me']);
  try {
    identifier = takeFlagValue(args, ['--identifier', '--id']);
    scope = takeFlagValue(args, ['--scope']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  if (scope !== undefined && scope !== 'runtime' && scope !== 'connector') {
    process.stderr.write(`${status.err('--scope must be runtime or connector')}\n`);
    return 2;
  }
  if (identifier !== undefined) {
    identifier = identifier.trim();
    if (!IDENTIFIER_RE.test(identifier)) {
      process.stderr.write(
        `${status.err(
          `invalid identifier "${identifier}" — start alphanumeric, then letters/digits/._- (max 128 chars)`,
        )}\n`,
      );
      return 2;
    }
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  if (args.length === 0) {
    process.stderr.write(`${status.err('Pass at least one KEY=VALUE pair.')}\n`);
    return 2;
  }

  const pairs: { key: string; value: string }[] = [];
  let stdinUsed = false;
  for (const raw of args) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      process.stderr.write(`${status.err(`malformed pair "${raw}" — expected KEY=VALUE`)}\n`);
      return 2;
    }
    // The backend uppercases + validates the key; do it here too so the printed
    // identifier/key match what's stored (parity with the web KEY_NAME field).
    const key = raw.slice(0, eq).trim().toUpperCase();
    let value = raw.slice(eq + 1);
    if (value === '-') {
      if (stdinUsed) {
        process.stderr.write(`${status.err('Only one KEY=- per invocation.')}\n`);
        return 2;
      }
      stdinUsed = true;
      value = readFileSync(0, 'utf8').replace(/\n$/, '');
    }
    pairs.push({ key, value });
  }

  if (identifier !== undefined && pairs.length !== 1) {
    process.stderr.write(
      `${status.err('--identifier addresses one secret — pass exactly one KEY=VALUE pair.')}\n`,
    );
    return 2;
  }

  let sharedWith: Array<{ principal_type: 'user'; principal_id: string }> | undefined;
  if (onlyMe) {
    try {
      const me = await ctx.client.get<{ user_id: string }>('/accounts/me');
      sharedWith = [{ principal_type: 'user', principal_id: me.user_id }];
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  let okCount = 0;
  for (const p of pairs) {
    const shownId = identifier ?? p.key;
    const label =
      shownId !== p.key
        ? `${C.bold}${shownId}${C.reset} ${C.dim}→ ${p.key}${C.reset}`
        : `${C.bold}${p.key}${C.reset}`;
    try {
      await ctx.client.post<ProjectSecret>(`/projects/${ctx.projectId}/secrets`, {
        name: p.key,
        ...(identifier !== undefined ? { identifier } : {}),
        // Same two scopes as `secrets request`: connector keeps the value
        // server-side for the connector gateway; runtime is the API default.
        ...(scope === 'connector' ? { strategy: 'broker', consumer: 'connector' } : {}),
        value: p.value,
        ...(sharedWith ? { shared_with: sharedWith } : {}),
      });
      okCount += 1;
      process.stdout.write(`${status.ok(label)}\n`);
    } catch (err) {
      surfaceApiError(err);
      process.stderr.write(`  ${C.dim}└─ for ${shownId}${C.reset}\n`);
    }
  }
  process.stdout.write(`\n  ${C.dim}${okCount}/${pairs.length} set${C.reset}\n\n`);
  return okCount === pairs.length ? 0 : 1;
}

/** `share IDENTIFIER --user … --group … | --everyone`: set the value's audience exactly. */
async function secretsShare(args: string[], opts: CtxOpts, json = false): Promise<number> {
  const everyone = takeFlagBool(args, ['--everyone']);
  let users: string[];
  let groups: string[];
  let agents: string[];
  try {
    users = takeFlagValues(args, ['--user']);
    groups = takeFlagValues(args, ['--group']);
    agents = takeFlagValues(args, ['--agent']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const identifier = args[0]?.trim();
  if (!identifier) {
    process.stderr.write(`${status.err('Usage: kortix secrets share IDENTIFIER --user <email|id|me> | --group <id> | --agent <name> | --everyone')}\n`);
    return 2;
  }
  if (everyone && users.length + groups.length + agents.length > 0) {
    process.stderr.write(`${status.err('--everyone shares it with the whole project; drop --user, --group and --agent.')}\n`);
    return 2;
  }
  if (!everyone && users.length + groups.length + agents.length === 0) {
    process.stderr.write(`${status.err('Say who can use it: --user <email|id|me>, --group <id>, --agent <name>, or --everyone.')}\n`);
    return 2;
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  try {
    const list = await ctx.client.get<ProjectSecretsResponse>(`/projects/${ctx.projectId}/secrets`);
    const target = list.items.find((item) => item.identifier.toUpperCase() === identifier.toUpperCase());
    if (!target) {
      process.stderr.write(`${status.err(`No secret with identifier "${identifier}". See: kortix secrets ls`)}\n`);
      return 1;
    }
    const principals: Array<{ principal_type: 'user' | 'group' | 'agent'; principal_id: string }> = groups.map((id) => ({
      principal_type: 'group',
      principal_id: id,
    }));
    let accountId: string | null = null;
    for (const who of users) {
      if (who === 'me') {
        const me = await ctx.client.get<{ user_id: string }>('/accounts/me');
        principals.push({ principal_type: 'user', principal_id: me.user_id });
        continue;
      }
      accountId ??= (await ctx.client.get<{ account_id: string }>(`/projects/${ctx.projectId}`)).account_id;
      const userId = await resolveUserId(ctx.client, accountId, who);
      if (!userId) return 1;
      principals.push({ principal_type: 'user', principal_id: userId });
    }
    if (agents.length > 0) {
      // An agent is its service account, one per (project, agent).
      const identities = (
        await ctx.client.get<{ agents: Array<{ service_account_id: string; agent_name: string | null }> }>(
          `/projects/${ctx.projectId}/agent-identities`,
        )
      ).agents;
      for (const name of agents) {
        const hit = identities.find((agent) => agent.agent_name === name);
        if (!hit) {
          process.stderr.write(`${status.err(`No agent "${name}" in this project. See: kortix agents ls`)}\n`);
          return 1;
        }
        principals.push({ principal_type: 'agent', principal_id: hit.service_account_id });
      }
    }
    const response = await ctx.client.post<ProjectSecret>(`/projects/${ctx.projectId}/secrets`, {
      name: target.name,
      identifier: target.identifier,
      shared_with: everyone ? [] : principals,
    });
    if (json) {
      emitJson(response);
      return 0;
    }
    const count = (type: string, one: string, many: string) => {
      const n = principals.filter((p) => p.principal_type === type).length;
      return n === 0 ? null : `${n} ${n === 1 ? one : many}`;
    };
    const audience = everyone
      ? 'everyone in the project'
      : [count('user', 'person', 'people'), count('group', 'group', 'groups'), count('agent', 'agent', 'agents')]
          .filter(Boolean)
          .join(', ');
    process.stdout.write(`${status.ok(`${target.identifier}: ${audience}`)}\n`);
    if (!everyone && users.length + groups.length > 0) {
      process.stdout.write(
        `  ${C.dim}People reach it directly or in their own private sessions — never a shared session or a trigger.${C.reset}\n`,
      );
    }
    if (agents.length > 0) {
      process.stdout.write(
        `  ${C.dim}An agent uses it in every session of the agent, triggers included: anyone who can run it can use the value through it.${C.reset}\n`,
      );
    }
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

async function secretsRequest(rest: string[], opts: CtxOpts, json = false): Promise<number> {
  let scope: string | undefined;
  let expires: string | undefined;
  try {
    scope = takeFlagValue(rest, ['--scope']);
    expires = takeFlagValue(rest, ['--expires']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const names = rest.map((n) => n.trim().toUpperCase()).filter(Boolean);
  if (names.length === 0) {
    process.stderr.write(`${status.err('Pass at least one secret NAME to request.')}\n`);
    return 2;
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: {
    url: string;
    names: string[];
    scope: string;
    expires_at: string;
    agent?: string;
    withheld?: Array<{ name: string; reason: 'agent_grant' | 'session_allowlist' }>;
    withheld_fix?: string;
  };
  try {
    resp = await ctx.client.post(`/projects/${ctx.projectId}/secret-requests`, {
      names,
      ...(scope ? { scope } : {}),
      ...(expires ? { expires_in_minutes: Number(expires) } : {}),
    });
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }

  process.stdout.write(
    `\n  ${C.bold}Hand this link to whoever has the value${C.reset} ${C.faded}(${resp.names.join(', ')})${C.reset}\n` +
      `  ${C.cyan}${resp.url}${C.reset}\n\n` +
      `  ${C.dim}Web: opens a fill-in modal. Slack: a tappable link.${C.reset}\n` +
      `  ${C.dim}Valid for ${describeLinkValidity(resp.expires_at, Date.now())} (until ${resp.expires_at}).${C.reset}\n` +
      `  ${C.dim}Reuse this link until it expires — do not mint a new one while this one is live.${C.reset}\n\n`,
  );
  // The value will be saved, and this session still will not see it. Say so
  // now, so the human does the one extra step in the same visit.
  if (resp.withheld && resp.withheld.length > 0) {
    process.stdout.write(
      `  ${status.warn(`This session will not receive ${resp.withheld.map((w) => w.name).join(', ')} after it is saved.`)}\n` +
        (resp.withheld_fix ? `  ${C.dim}${resp.withheld_fix}${C.reset}\n` : '') +
        '\n',
    );
  }
  return 0;
}

export function describeLinkValidity(expiresAtIso: string, nowMs: number): string {
  const expiresMs = Date.parse(expiresAtIso);
  if (Number.isNaN(expiresMs) || expiresMs <= nowMs) return 'an unknown window';
  const minutes = Math.round((expiresMs - nowMs) / 60_000);
  if (minutes >= 2 * 24 * 60) return `${Math.round(minutes / (24 * 60))} days`;
  if (minutes >= 2 * 60) return `${Math.round(minutes / 60)} hours`;
  return `${Math.max(minutes, 1)} minute${minutes === 1 ? '' : 's'}`;
}

async function secretsUnset(names: string[], opts: CtxOpts): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  if (names.length === 0) {
    process.stderr.write(`${status.err('Pass at least one secret name to unset.')}\n`);
    return 2;
  }

  let okCount = 0;
  for (const name of names) {
    try {
      await ctx.client.delete(`/projects/${ctx.projectId}/secrets/${encodeURIComponent(name)}`);
      okCount += 1;
      process.stdout.write(`${status.ok(`removed ${C.bold}${name}${C.reset}`)}\n`);
    } catch (err) {
      surfaceApiError(err);
      process.stderr.write(`  ${C.dim}└─ for ${name}${C.reset}\n`);
    }
  }
  process.stdout.write(`\n  ${C.dim}${okCount}/${names.length} removed${C.reset}\n\n`);
  return okCount === names.length ? 0 : 1;
}


/**
 * Force a re-push of all project secrets to this session's sandbox daemon.
 * Use after setting a secret via the intake link or when secrets are missing
 * from the agent's shell environment despite being set in the store.
 *
 * The backend's propagateProjectSecretsToActiveSandboxes fans out to every
 * active sandbox. This command triggers the same propagation by calling the
 * project's secret-propagation endpoint.
 */
async function secretsSync(opts: CtxOpts, json = false): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  try {
    const result = await ctx.client.post<{
      ok: boolean;
      active_sandboxes: number;
      targeted: number;
      synced: number;
      failed: number;
      exported: number;
      results: Array<{
        session_id: string;
        sandbox_id: string | null;
        status: 'synced' | 'failed';
        scope: 'inherit' | 'restricted' | 'none' | null;
        revision: string | null;
        exported: number;
        managed: number | null;
        withheld: number | null;
        agent_env_written: boolean;
        reason?: string;
      }>;
    }>(
      `/projects/${ctx.projectId}/secrets/sync`,
      {},
    );
    if (json) {
      emitJson(result);
      return result.ok ? 0 : 1;
    }
    if (result.ok) {
      if (result.active_sandboxes === 0) {
        process.stdout.write(`\n${status.ok('No active sandboxes require secret synchronization.')}\n\n`);
        return 0;
      }
      process.stdout.write(
        `\n${status.ok(`Verified ${result.exported} secret export(s) across ${result.synced}/${result.active_sandboxes} active sandbox(es).`)}\n`,
      );
      for (const target of result.results) {
        const scope = target.scope === 'none' ? ' · scope permits zero secrets' : '';
        process.stdout.write(
          `  ${C.dim}${target.session_id}: ${target.exported} exported · revision ${target.revision}${scope}${C.reset}\n`,
        );
      }
      process.stdout.write('\n');
      return 0;
    }

    process.stderr.write(
      `${status.err(`Secret sync incomplete: ${result.synced} synced, ${result.failed} failed.`)}\n`,
    );
    for (const target of result.results.filter((item) => item.status === 'failed')) {
      process.stderr.write(
        `  ${C.dim}${target.session_id || 'project'}: ${target.reason ?? 'delivery verification failed'}${C.reset}\n`,
      );
    }
    return 1;
  } catch (err) {
    return surfaceApiError(err);
  }
}
