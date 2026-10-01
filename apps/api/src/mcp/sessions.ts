import { ToolInputError, apiResult, arg, callApi, limitArg, optionalArg, projectArg, sessionActivity, sessionPath, sleep, text, type ApiReply, type ToolContext, type ToolResult } from './common';
import { mintWireMessageId } from '@kortix/sdk';
import { shapeTranscript } from './shape';

async function toolStartSession(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const body: Record<string, unknown> = { initial_prompt: arg(input, 'prompt') };
  if (optionalArg(input, 'name')) body.name = optionalArg(input, 'name');
  if (optionalArg(input, 'agent')) body.agent_name = optionalArg(input, 'agent');
  const r = await callApi(ctx, 'POST', `/v1/projects/${projectArg(input)}/sessions`, { body });
  if (r.status >= 400) return apiResult(r);
  const session = JSON.parse(r.body);
  return text(
    JSON.stringify(
      { session_id: session.session_id, project_id: session.project_id, name: session.name ?? null, status: session.status, branch: session.branch_name ?? null },
      null,
      2,
    ),
  );
}

async function toolSendMessage(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const sessionId = arg(input, 'session_id');
  const message = arg(input, 'text');
  const path = await sessionPath(sessionId);
  const found = await callApi(ctx, 'GET', path);
  if (found.status >= 400) return apiResult(found);
  const session = JSON.parse(found.body);
  // The same body `kortix sessions chat --queue` sends (apps/cli/src/commands/sessions-queue.ts).
  const model = typeof session.metadata?.opencode_model === 'string' ? session.metadata.opencode_model : '';
  const slash = model.indexOf('/');
  const overrides = {
    ...(session.agent_name ? { agent: session.agent_name } : {}),
    ...(slash > 0 ? { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } } : {}),
  };
  const clientMessageId = crypto.randomUUID();
  const messageId = mintWireMessageId();
  const queued = await callApi(ctx, 'POST', `${path}/prompts`, {
    body: {
      client_message_id: clientMessageId,
      message_id: messageId,
      parts: [{ type: 'text', text: message }],
      client_sent_at_ms: Date.now(),
      remint_on_delivery: true,
      ...(Object.keys(overrides).length ? { overrides } : {}),
    },
  });
  if (queued.status >= 400) return apiResult(queued);
  // Start after the prompt is queued: start drains the inbox of a stopped session.
  const start = await callApi(ctx, 'POST', `${path}/start`, { body: {} });
  return text(
    JSON.stringify({ queued: true, started: start.status < 400, session_id: sessionId, message_id: messageId, client_message_id: clientMessageId }, null, 2),
  );
}

async function toolReadSession(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const path = await sessionPath(arg(input, 'session_id'));
  const limit = limitArg(input, 'limit', 10, 100);
  const wait = input.wait_seconds === undefined ? 0 : limitArg(input, 'wait_seconds', 1, 45) * 1000;
  // The activity poll and the transcript read must both end inside the request budget.
  const deadline = Math.min(Date.now() + wait, ctx.deadline - 12_000);
  let activity = await sessionActivity(ctx, path);
  while (!('error' in activity) && activity.busy && Date.now() + 2_000 < deadline) {
    await sleep(2_000);
    activity = await sessionActivity(ctx, path);
  }
  if ('error' in activity) return apiResult(activity.error!);
  const late = Symbol('late');
  const transcript = await Promise.race([
    callApi(ctx, 'GET', `${path}/transcript`, { query: { limit, chars: 1500, detail: 'full' } }),
    sleep(Math.max(ctx.deadline - Date.now() - 2_000, 0)).then(() => late),
  ]);
  const note = typeof transcript === 'symbol' ? 'transcript: not read inside the request budget; call again' : transcript.status >= 400 ? `transcript: HTTP ${transcript.status} ${transcript.body}` : null;
  if (note) return text(`${JSON.stringify(activity.summary, null, 2)}\n\n${note}`);
  return text(shapeTranscript(activity.summary, JSON.parse((transcript as ApiReply).body)));
}

async function toolListSessions(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const r = await callApi(ctx, 'GET', `/v1/projects/${projectArg(input)}/sessions`, {
    query: { limit: limitArg(input, 'limit', 20, 200), cursor: optionalArg(input, 'cursor') },
  });
  if (r.status >= 400) return apiResult(r);
  const rows = (JSON.parse(r.body) as any[]).map((s) => ({
    session_id: s.session_id,
    name: s.name ?? null,
    status: s.status,
    agent: s.agent_name,
    owner: s.owner_name ?? s.owner_email ?? null,
    origin: s.origin,
    branch: s.branch_name ?? null,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));
  return text(JSON.stringify({ sessions: rows, next_cursor: r.nextCursor ?? null }, null, 2));
}

export async function dispatchSessions(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult | undefined> {
  switch (name) {
    case 'start_session': return toolStartSession(ctx, input);
    case 'send_message': return toolSendMessage(ctx, input);
    case 'read_session': return toolReadSession(ctx, input);
    case 'list_sessions': return toolListSessions(ctx, input);
    default: return undefined;
  }
}
