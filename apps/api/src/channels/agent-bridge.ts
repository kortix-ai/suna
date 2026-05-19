import { eq } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { resolveGitTriggerActor } from '../projects';
import { proxyToDaytona } from '../sandbox-proxy/routes/preview';
import {
  isMessagePartDelta,
  isSessionError,
  isSessionIdle,
  parseOpencodeSse,
} from './opencode-stream';

const AGENT_PORT = 8000;
const PROMPT_TIMEOUT_MS = 90_000;
const WORKSPACE_PATH = '/workspace';
const DIRECTORY_QUERY = `?directory=${encodeURIComponent(WORKSPACE_PATH)}`;

interface AgentContext {
  externalId: string;
  userId: string;
}

async function loadAgentContext(sessionId: string, accountId: string): Promise<AgentContext | null> {
  const [row] = await db
    .select({ externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  if (!row?.externalId) return null;
  const userId = await resolveGitTriggerActor(accountId);
  if (!userId) return null;
  return { externalId: row.externalId, userId };
}

async function callSandbox(
  ctx: AgentContext,
  method: string,
  path: string,
  queryString: string,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers();
  headers.set(
    'accept',
    method === 'GET' && path.includes('/event') ? 'text/event-stream' : 'application/json',
  );
  let payload: ArrayBuffer | undefined;
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    payload = new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer;
  }
  return proxyToDaytona(
    ctx.externalId,
    AGENT_PORT,
    ctx.userId,
    method,
    path,
    queryString,
    headers,
    payload,
    'http://internal',
  );
}

interface OpencodeSession {
  id: string;
  [k: string]: unknown;
}

async function resolveOpencodeSessionId(
  ctx: AgentContext,
  kortixSessionId: string,
): Promise<string> {
  const [row] = await db
    .select({ opencodeSessionId: projectSessions.opencodeSessionId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, kortixSessionId))
    .limit(1);
  if (row?.opencodeSessionId) return row.opencodeSessionId;

  const res = await callSandbox(ctx, 'POST', '/session', DIRECTORY_QUERY, {});
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`session create failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const created = (await res.json()) as OpencodeSession;
  await db
    .update(projectSessions)
    .set({ opencodeSessionId: created.id, updatedAt: new Date() })
    .where(eq(projectSessions.sessionId, kortixSessionId));
  return created.id;
}

async function sendPrompt(
  ctx: AgentContext,
  opencodeSessionId: string,
  text: string,
  agent: string,
): Promise<void> {
  const body: Record<string, unknown> = { parts: [{ type: 'text', text }] };
  if (agent && agent !== 'default') body.agent = agent;
  const res = await callSandbox(
    ctx,
    'POST',
    `/session/${opencodeSessionId}/prompt_async`,
    DIRECTORY_QUERY,
    body,
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`prompt_async failed (${res.status}): ${errBody.slice(0, 300)}`);
  }
}

export async function* streamAgentResponse(
  sessionId: string,
  accountId: string,
  userText: string,
  agent: string,
): AsyncIterable<string> {
  const ctx = await loadAgentContext(sessionId, accountId);
  if (!ctx) {
    yield 'Could not resolve sandbox context for this session.';
    return;
  }

  let opencodeSessionId: string;
  try {
    opencodeSessionId = await resolveOpencodeSessionId(ctx, sessionId);
  } catch (err) {
    yield `Failed to open agent session: ${(err as Error).message}`;
    return;
  }

  const eventRes = await callSandbox(ctx, 'GET', '/global/event', '');
  if (!eventRes.ok || !eventRes.body) {
    yield `Failed to subscribe to agent events (${eventRes.status}).`;
    return;
  }

  try {
    await sendPrompt(ctx, opencodeSessionId, userText, agent);
  } catch (err) {
    yield (err as Error).message;
    return;
  }

  const deadline = Date.now() + PROMPT_TIMEOUT_MS;
  for await (const event of parseOpencodeSse(eventRes.body)) {
    if (Date.now() > deadline) {
      yield '\n_(timed out — open the session in the dashboard to keep going.)_';
      return;
    }
    if (event.properties.sessionID !== opencodeSessionId) continue;

    if (isMessagePartDelta(event)) {
      if (event.properties.field === 'text' && event.properties.delta.length > 0) {
        yield event.properties.delta;
      }
    } else if (isSessionIdle(event)) {
      return;
    } else if (isSessionError(event)) {
      const err = event.properties.error;
      yield `\n_(agent error: ${typeof err === 'string' ? err : JSON.stringify(err)})_`;
      return;
    }
  }
}
