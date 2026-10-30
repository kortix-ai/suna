/**
 * Foreign tool history probe (Session Log Plan P7.2). Paid: one small call per
 * provider, max 64 output tokens, well under 0.01 USD for the whole run.
 *
 * A session switched to another harness replays the old harness's tool calls.
 * This sends each configured provider, through the real `@kortix/llm-gateway`
 * pipeline and the descriptors this API builds, a history with a Claude Code
 * `Bash` call + result and a Codex `apply_patch` call + result. The history is
 * the session-log `threadView` of a synthetic log, rendered in the OpenAI chat
 * dialect pi sends (with pi's own `bash` tool and `max_completion_tokens`).
 * Scope: that dialect only. Anthropic Messages and Bedrock Converse ingress are
 * reached only as the gateway translates this request for a BYOK upstream.
 *
 * Keys come from the environment only. Run from apps/api:
 *
 *   dotenvx run -q -f .env -- env KORTIX_URL=http://localhost:8008 bun scripts/llm-foreign-tool-history-probe.ts
 *
 * `PROBE_ONLY=openai,xai` limits the providers (label prefixes), `PROBE_CONTROL=1`
 * adds a no-history control call per provider, `PROBE_BEDROCK_REGION` sets the
 * Bedrock region (default us-east-1). Output: one Markdown table row per call
 * (status, finish reason, token counts) and, for a failure, the provider's error
 * message. No prompt or completion content.
 */
import { createGateway, type GatewayHooks, type UpstreamDescriptor, type UsageEvent } from '@kortix/llm-gateway';
import { threadView, type SessionLog } from '@kortix/api-contract/session-log';
import { getRuntimeManagedModel, loadManagedLineup } from '../src/llm-gateway/models/managed-models';
import { bedrockByokBaseUrl, managedCandidates } from '../src/llm-gateway/resolution/descriptors';
import { resolveCatalogUpstream } from '../src/llm-gateway/models/provider-registry';

const msg = (seq: number, role: 'user' | 'assistant', blocks: unknown[], model?: { provider: string; model: string }) =>
  ({ message_id: `m${seq}`, seq, role, kind: 'turn', in_context: true, blocks, ...(model ? { model } : {}) });
const result = (text: string) => ({ content: [{ type: 'text', text }], is_error: false });
// Only the fields threadView reads.
const log = {
  threads: [{
    thread_id: 't1', parent_thread_id: null, messages: [
      msg(1, 'user', [{ type: 'text', id: 'b1', text: 'List the files, then add a line to notes.txt.' }]),
      msg(2, 'assistant', [{ type: 'tool_call', id: 'b2', call_id: 'toolu_01', name: 'Bash', input: { command: 'ls', description: 'List files' }, result: result('notes.txt') }], { provider: 'anthropic', model: 'claude-code-model' }),
      msg(3, 'assistant', [{ type: 'tool_call', id: 'b3', call_id: 'call_02', name: 'apply_patch', input: { input: '*** Begin Patch\n*** Update File: notes.txt\n@@\n+hello\n*** End Patch' }, result: result('Success. Updated the following files:\nM notes.txt') }], { provider: 'openai', model: 'codex-model' }),
      msg(4, 'assistant', [{ type: 'text', id: 'b4', text: 'Done: notes.txt has the new line.' }], { provider: 'openai', model: 'codex-model' }),
    ],
  }],
} as unknown as SessionLog;

/** The view, rendered as OpenAI chat (the inverse of `normalizeOpenAIChat`). */
function chatBody(model: string, control: boolean) {
  const view = threadView(log, 't1', { provider: 'kortix', model, reasoning_replay: 'same_model' }, { next_prompt: 'Reply with the single word OK.' });
  const history = control ? [{ role: 'user', content: 'Reply with the single word OK.' }] : view.map((it) =>
    it.role === 'user' ? { role: 'user', content: it.text.join('\n') }
      : it.role === 'assistant' ? { role: 'assistant', content: it.text.join('') || null, ...(it.calls.length ? { tool_calls: it.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) }
        : it.role === 'tool' ? { role: 'tool', tool_call_id: it.call_id, content: it.content }
          : { role: 'user', content: it.text });
  const tools = [{ type: 'function', function: { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }];
  return { model, max_completion_tokens: 64, messages: [{ role: 'system', content: 'You are a coding agent.' }, ...history], tools };
}

const BEDROCK_REGION = process.env.PROBE_BEDROCK_REGION ?? 'us-east-1';
function byok(provider: string, model: string, envVar: string): UpstreamDescriptor | string {
  const apiKey = process.env[envVar];
  if (!apiKey) return `${envVar} is not set`;
  const up = resolveCatalogUpstream(provider, model);
  if (!up) return `no catalog upstream for ${provider}`;
  const bedrock = up.kind === 'bedrock';
  return { provider, kind: up.kind, npm: up.npm, baseUrl: bedrock ? bedrockByokBaseUrl(BEDROCK_REGION) : up.baseUrl, ...(bedrock ? { region: BEDROCK_REGION } : {}), apiKey, billingMode: 'none', markup: 0, resolvedModel: model } as UpstreamDescriptor;
}

await loadManagedLineup();
const glm = getRuntimeManagedModel('glm-5.3-flash');
const managed = glm ? managedCandidates(glm) : [];
const pick = (provider: string) => managed.find((c) => c.provider === provider) ?? `not a managed candidate here`;
const cases: Array<{ label: string; model: string; upstream: UpstreamDescriptor | string }> = [
  { label: 'platinum (managed)', model: 'glm-5.3-flash', upstream: pick('platinum') },
  { label: 'openrouter (BYOK, Claude)', model: 'anthropic/claude-haiku-4.5', upstream: byok('openrouter', 'anthropic/claude-haiku-4.5', 'OPENROUTER_API_KEY') },
  { label: 'openai (BYOK)', model: 'gpt-4.1-nano', upstream: byok('openai', 'gpt-4.1-nano', 'OPENAI_API_KEY') },
  { label: 'xai (BYOK)', model: 'grok-4.3', upstream: byok('xai', 'grok-4.3', 'XAI_API_KEY') },
  { label: 'amazon-bedrock (BYOK, Claude)', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', upstream: byok('amazon-bedrock', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'AWS_BEDROCK_API_KEY') },
  { label: 'anthropic (BYOK)', model: 'claude-haiku-4-5', upstream: byok('anthropic', 'claude-haiku-4-5', 'ANTHROPIC_API_KEY') },
];

type Reply = { choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: unknown[] } }>; error?: { code?: string; type?: string; message?: string }; code?: string; message?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };
const only = process.env.PROBE_ONLY?.split(',');
const rows: string[] = [];
for (const { label, model, upstream } of cases) for (const control of process.env.PROBE_CONTROL ? [false, true] : [false]) {
  if (only && !only.some((o) => label.startsWith(o))) continue;
  const name = `${label}${control ? ' (control, no history)' : ''}`;
  if (typeof upstream === 'string') { if (!control) rows.push(`| ${name} | ${model} | not run: ${upstream} | | |`); continue; }
  const usage: UsageEvent[] = [];
  const hooks: GatewayHooks = {
    authenticate: async () => ({ userId: 'probe-user', accountId: 'probe-account' }),
    resolveUpstream: async () => [upstream],
    assertBillingActive: async () => {},
    recordUsage: async (event) => { usage.push(event); },
  };
  const res = await createGateway(hooks).chatCompletions({ authorization: 'Bearer probe', rawBody: JSON.stringify(chatBody(model, control)) });
  const body = (await res.json().catch(() => ({}))) as Reply;
  await Bun.sleep(200); // recordUsage settles after the response
  const choice = body.choices?.[0];
  const shape = choice ? `${choice.finish_reason}, ${choice.message?.content ? 'text' : 'no text'}` : `error ${body.code ?? body.error?.code ?? body.error?.type ?? '?'}`;
  if (!choice) console.error(`[probe] ${name}: ${(body.error?.message ?? body.message ?? '').slice(0, 300)}`);
  rows.push(`| ${name} | ${model} | ${res.status} (${shape}) | ${usage[0]?.promptTokens ?? body.usage?.prompt_tokens ?? '-'} | ${usage[0]?.completionTokens ?? body.usage?.completion_tokens ?? '-'} |`);
}
console.log('| provider | model | status | input tokens | output tokens |\n|---|---|---|---|---|');
console.log(rows.join('\n'));
