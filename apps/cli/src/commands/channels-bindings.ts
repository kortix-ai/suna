import {
  emitJson,
  fail,
  resolveProjectContext,
  surfaceApiError,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';
import type { ExtraFlags } from './channels.ts';

// ── Channel bindings ────────────────────────────────────────────────────────
// apps/api/src/projects/routes/channel-bindings.ts.

const CONVERSATION_POLICIES = ['owner_approval', 'owner_only', 'project_open'] as const;
type ConversationPolicy = (typeof CONVERSATION_POLICIES)[number];

interface ChannelBinding {
  bindingId: string;
  platform: string;
  workspaceId: string;
  channelId: string;
  channelName: string | null;
  channelType: string | null;
  /** Slack answered that the conversation is deleted or out of the bot's reach. */
  channelUnavailable?: boolean;
  /** A Teams channel thread: its session's title, which tells threads of one channel apart. */
  threadTitle?: string | null;
  agentName: string | null;
  opencodeModel: string | null;
  conversationPolicy: ConversationPolicy;
  installedAt: string;
  effectiveAgent: { agent: string; source: string };
  effectiveModel: { model: string | null; source: string };
}

interface ChannelBindingsResponse {
  projectDefaultAgent: string | null;
  bindings: ChannelBinding[];
}

// ─── Channel bindings ────────────────────────────────────────────────────

/** `#general`, a person's name for a Slack DM, or the id when nothing names it. */
function bindingLabel(b: ChannelBinding): string {
  if (b.platform === 'slack') {
    if (b.channelName) return b.channelType === 'im' || b.channelType === 'mpim' ? b.channelName : `#${b.channelName}`;
    if (b.channelUnavailable) return `unavailable (${b.channelId})`;
  }
  if (b.threadTitle) return `${b.channelName ?? b.channelId} · ${b.threadTitle}`;
  return b.channelName ?? b.channelId;
}

export async function bindingsLs(
  ctxOpts: { projectArg?: string; hostArg?: string },
  rest: string[],
  json: boolean,
): Promise<number> {
  const action = rest.find((a) => !a.startsWith('-')) ?? 'ls';
  if (action !== 'ls' && action !== 'list') {
    return fail(`unknown bindings action "${action}" — ls`);
  }
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  let resp: ChannelBindingsResponse;
  try {
    resp = await ctx.client.get<ChannelBindingsResponse>(
      `/projects/${ctx.projectId}/channels/bindings`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(resp);
    return 0;
  }
  if (resp.bindings.length === 0) {
    process.stdout.write(
      `  ${C.dim}No bound channels. Invite the bot to a channel first.${C.reset}\n`,
    );
    return 0;
  }
  const idW = Math.max(...resp.bindings.map((b) => b.bindingId.length), 10);
  const chW = Math.max(...resp.bindings.map((b) => bindingLabel(b).length), 7);
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('BINDING', idW)}  ${pad('CHANNEL', chW)}  PLATFORM  AGENT             MODEL             POLICY${C.reset}\n`,
  );
  for (const b of resp.bindings) {
    const agent = `${b.effectiveAgent.agent}${b.agentName ? '' : ` ${C.faded}(${b.effectiveAgent.source})${C.reset}`}`;
    const model = `${b.effectiveModel.model ?? 'auto'}${b.opencodeModel ? '' : ` ${C.faded}(${b.effectiveModel.source})${C.reset}`}`;
    process.stdout.write(
      `  ${pad(b.bindingId, idW)}  ${pad(bindingLabel(b), chW)}  ` +
        `${pad(b.platform, 8)}  ${pad(agent, 26)}  ${pad(model, 26)}  ${C.faded}${b.conversationPolicy}${C.reset}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}${resp.bindings.length} binding${resp.bindings.length === 1 ? '' : 's'} · project default agent: ${resp.projectDefaultAgent ?? '—'}${C.reset}\n` +
      `  ${C.dim}Change one: ${C.reset}${C.cyan}kortix channels bind <bindingId> --agent <name>${C.reset}\n\n`,
  );
  return 0;
}

export async function bindingsPatch(
  ctxOpts: { projectArg?: string; hostArg?: string },
  rest: string[],
  extra: ExtraFlags,
  json: boolean,
): Promise<number> {
  const bindingId = rest.find((a) => !a.startsWith('-'));
  if (!bindingId) return fail('Pass a binding id — list them with `kortix channels bindings`.');
  if (extra.agent && extra.noAgent) return fail('Pass --agent or --no-agent, not both.');
  if (extra.model && extra.noModel) return fail('Pass --model or --no-model, not both.');
  if (extra.policy && !(CONVERSATION_POLICIES as readonly string[]).includes(extra.policy)) {
    return fail(`--policy must be one of ${CONVERSATION_POLICIES.join(', ')}.`);
  }

  // `null` resets an override to the project default; an omitted key leaves it
  // alone (channel-bindings.ts:161). All three omitted is a 400 `empty_patch`,
  // so refuse it here with usage instead of a round trip.
  const body: Record<string, unknown> = {};
  if (extra.agent) body.agentName = extra.agent;
  else if (extra.noAgent) body.agentName = null;
  if (extra.model) body.opencodeModel = extra.model;
  else if (extra.noModel) body.opencodeModel = null;
  if (extra.policy) body.conversationPolicy = extra.policy;
  if (Object.keys(body).length === 0) {
    return fail('Pass at least one of --agent/--no-agent, --model/--no-model, --policy.');
  }

  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  let binding: ChannelBinding;
  try {
    binding = await ctx.client.patch<ChannelBinding>(
      `/projects/${ctx.projectId}/channels/bindings/${encodeURIComponent(bindingId)}`,
      body,
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(binding);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`${C.bold}${bindingLabel(binding)}${C.reset} updated`)}\n` +
      `         agent   ${C.cyan}${binding.effectiveAgent.agent}${C.reset} ${C.faded}(${binding.effectiveAgent.source})${C.reset}\n` +
      `         model   ${C.cyan}${binding.effectiveModel.model ?? 'auto'}${C.reset} ${C.faded}(${binding.effectiveModel.source})${C.reset}\n` +
      `         policy  ${C.dim}${binding.conversationPolicy}${C.reset}\n`,
  );
  return 0;
}
