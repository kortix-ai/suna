import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
  fail,
} from '../command-helpers.ts';
import { resolveUserId } from '../iam.ts';
import { C, status } from '../style.ts';
import type { ProjectSecret, ProjectSecretsResponse } from '../api/types.ts';
import type { CtxOpts } from './secrets.ts';
import { IDENTIFIER_RE } from './secrets-delivery.ts';

/** `share IDENTIFIER --user … --group … | --everyone`: set the value's audience exactly. */
export async function secretsShare(args: string[], opts: CtxOpts, json = false): Promise<number> {
  const everyone = takeFlagBool(args, ['--everyone']);
  let users: string[];
  let groups: string[];
  let agents: string[];
  try {
    users = takeFlagValues(args, ['--user']);
    groups = takeFlagValues(args, ['--group']);
    agents = takeFlagValues(args, ['--agent']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const identifier = args[0]?.trim();
  if (!identifier) {
    return fail('Usage: kortix secrets share IDENTIFIER --user <email|id|me> | --group <id> | --agent <name> | --everyone');
  }
  if (everyone && users.length + groups.length + agents.length > 0) {
    return fail('--everyone shares it with the whole project; drop --user, --group and --agent.');
  }
  if (!everyone && users.length + groups.length + agents.length === 0) {
    return fail('Say who can use it: --user <email|id|me>, --group <id>, --agent <name>, or --everyone.');
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

export async function secretsRequest(rest: string[], opts: CtxOpts, json = false): Promise<number> {
  let scope: string | undefined;
  let expires: string | undefined;
  try {
    scope = takeFlagValue(rest, ['--scope']);
    expires = takeFlagValue(rest, ['--expires']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const names = rest.map((n) => n.trim().toUpperCase()).filter(Boolean);
  if (names.length === 0) {
    return fail('Pass at least one secret NAME to request.');
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

/**
 * Grant one secret to one agent.
 *
 * `enforced` and `none` exposures reach a session ONLY when some agent's
 * `secrets:` list names the identifier — `secrets: all` withholds both — so a
 * stored, valid secret can be delivered nowhere at all. That is the
 * `undeliverable` marker `ls` prints, and this is the one command that clears
 * it. It only widens the named agent's list; it never replaces it.
 */
export async function secretsGrant(argv: string[], opts: CtxOpts, json = false): Promise<number> {
  let agent: string | undefined;
  try {
    agent = takeFlagValue(argv, ['--agent']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const identifier = argv.filter((a) => !a.startsWith('-'))[0];
  if (!identifier) {
    return fail('Pass a secret identifier.');
  }
  if (!agent) {
    process.stderr.write(
      `${status.err('Pass --agent <name>.')} ${C.dim}See ${C.reset}${C.cyan}kortix agents ls${C.reset}${C.dim}.${C.reset}\n`,
    );
    return 2;
  }
  if (!IDENTIFIER_RE.test(identifier)) {
    return fail(`"${identifier}" is not a valid secret identifier.`);
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: {
    identifier: string;
    agent: string;
    already_granted: boolean;
    adopted_governance: boolean;
  };
  try {
    resp = await ctx.client.post<typeof resp>(
      `/projects/${ctx.projectId}/secrets/${encodeURIComponent(identifier)}/grant`,
      { agent },
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    resp.already_granted
      ? `${status.info(`${C.bold}${resp.agent}${C.reset} already receives ${C.bold}${resp.identifier}${C.reset}`)}\n`
      : `${status.ok(`${C.bold}${resp.agent}${C.reset} now receives ${C.bold}${resp.identifier}${C.reset}`)}\n`,
  );
  // This edit can flip the project from "every agent gets everything" to "only
  // listed agents get anything". Nothing else says so, and the blast radius is
  // every other agent on the project.
  if (resp.adopted_governance) {
    process.stdout.write(
      `${status.warn('This wrote the first `agents:` block — an agent that is not listed now receives NO project secrets.')}\n`,
    );
  }
  return 0;
}

