import { startSessionBody, listSessionsQuery, listSessionRow, ToolInputError, apiResult, arg, callApi, limitArg, optionalArg, projectArg, sessionActivity, sessionPath, sleep, text, type ApiReply, type ToolContext, type ToolResult } from './common';
import { mintWireMessageId } from '@kortix/sdk';
import { shapeTranscript } from './shape';

export async function dispatchSessions(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult | undefined> {
  switch (name) {
    case 'start_session': {
      const body = startSessionBody(input);
      const r = await callApi(ctx, 'POST', `/v1/projects/${projectArg(input)}/sessions`, { body });
      if (r.status >= 400) return apiResult(r);
      const session = JSON.parse(r.body);
      return text(
        JSON.stringify(
          { session_id: session.session_id, project_id: session.project_id, name: session.name ?? null, labels: session.labels ?? [], status: session.status, branch: session.branch_name ?? null },
          null,
          2,
        ),
      );
    }
    case 'send_message': {
      if (Array.isArray(input.to)) {
        const r = await callApi(ctx, 'POST', `/v1/projects/${projectArg(input)}/sessions`, {
          body: { participants: input.to, initial_prompt: arg(input, 'text') },
        });
        if (r.status >= 400) return apiResult(r);
        const session = JSON.parse(r.body);
        return text(JSON.stringify({ session_id: session.session_id, project_id: session.project_id, name: session.name ?? null, to: input.to }, null, 2));
      }
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
    case 'read_session': {
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
    case 'list_sessions': {
      const r = await callApi(ctx, 'GET', `/v1/projects/${projectArg(input)}/sessions`, { query: listSessionsQuery(input) });
      if (r.status >= 400) return apiResult(r);
      const rows = (JSON.parse(r.body) as any[]).map(listSessionRow);
      return text(JSON.stringify({ sessions: rows, next_cursor: r.nextCursor ?? null }, null, 2));
    }
    default: return undefined;
  }
}
