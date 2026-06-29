import { createRoute, z } from '@hono/zod-openapi';
import { continueSession } from '../projects/session-lifecycle';
import { makeOpenApiApp, json, errors } from '../openapi';
import { MEET_DEFAULT_WAKE, verifyMeetSessionToken } from './meet-realtime';
import { type MeetTurn, meetConversation } from './meet-conversation';
import { playAcknowledgement } from './meet-tts';

export const meetWebhookApp = makeOpenApiApp();

meetWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/realtime',
    tags: ['channels'],
    summary: 'Recall.ai real-time meeting events (transcript + chat)',
    request: { body: { content: { 'application/json': { schema: z.any() } } } },
    responses: {
      200: json(z.object({ ok: z.boolean() }).passthrough(), 'Accepted'),
      ...errors(400, 401),
    },
  }),
  async (c: any) => {
    let body: RealtimeEvent;
    try {
      body = (await c.req.json()) as RealtimeEvent;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const meta = (body?.data?.bot?.metadata ?? {}) as Record<string, unknown>;
    const sessionId = typeof meta.kortix_session_id === 'string' ? meta.kortix_session_id : '';
    const token = typeof meta.kortix_token === 'string' ? meta.kortix_token : '';
    if (!verifyMeetSessionToken(sessionId, token)) {
      return c.json({ error: 'unverified' }, 401);
    }

    const turn = extractTurn(body);
    if (turn?.text) {
      const projectId = typeof meta.kortix_project_id === 'string' ? meta.kortix_project_id : '';
      const botId = body?.data?.bot?.id ?? '';
      const wake = (typeof meta.kortix_wake === 'string' ? meta.kortix_wake : MEET_DEFAULT_WAKE).toLowerCase();
      meetConversation.ingest({
        sessionId,
        speaker: turn.speaker,
        text: turn.text,
        spoken: turn.spoken,
        wake,
        deliver: (delivered) => deliverTurn({ projectId, sessionId, botId, turn: delivered }),
      });
    }
    return c.json({ ok: true });
  },
);

function deliverTurn(args: { projectId: string; sessionId: string; botId: string; turn: MeetTurn }): void {
  const { projectId, sessionId, botId, turn } = args;

  if (turn.spoken && projectId && botId) {
    void playAcknowledgement(projectId, botId).catch((err) =>
      console.error('[meet-webhook] acknowledgement failed', err),
    );
  }

  void continueSession({ source: 'meet', sessionId, text: buildWakePrompt({ ...turn, botId }), userId: null })
    .then((outcome) => {
      if (outcome === 'no-session' || outcome === 'failed') {
        console.warn('[meet-webhook] delivery', outcome, 'session', sessionId);
      }
    })
    .catch((err) => console.error('[meet-webhook] deliver failed', err));
}

export function buildWakePrompt(turn: { speaker: string; text: string; spoken: boolean; botId: string }): string {
  const verb = turn.spoken ? 'said (spoken)' : 'wrote in the chat';
  const replyLine = turn.spoken
    ? `They SPOKE to you — reply OUT LOUD, short and conversational (no markdown, no URLs):\n  meet speak ${turn.botId} "<your reply>"`
    : `They TYPED in the chat — reply IN THE CHAT:\n  meet chat ${turn.botId} "<your reply>"`;
  return [
    `[Live meeting] ${turn.speaker} ${verb}: "${turn.text}"`,
    '',
    `You're live in this meeting (bot id ${turn.botId}) and were just addressed. They can keep talking to you for a moment without repeating your name, so stay in the conversation.`,
    replyLine,
    `Keep it to a sentence or two — you're in a live call. If no reply is actually needed, do nothing.`,
  ].join('\n');
}

export function extractTurn(body: RealtimeEvent): { speaker: string; text: string; spoken: boolean } | null {
  const inner = body?.data?.data ?? {};
  const speaker = (inner.participant?.name as string) || 'Someone';
  if (body.event === 'transcript.data') {
    const text = (inner.words ?? []).map((w) => w?.text ?? '').join(' ').trim();
    return { speaker, text, spoken: true };
  }
  if (body.event === 'participant_events.chat_message') {
    const chat = inner.data ?? {};
    const text = String(chat.text ?? chat.message ?? inner.text ?? '').trim();
    return { speaker, text, spoken: false };
  }
  return null;
}

interface RealtimeEvent {
  event: string;
  data?: {
    bot?: { id?: string; metadata?: Record<string, unknown> };
    data?: {
      participant?: { name?: string };
      words?: Array<{ text?: string }>;
      data?: { text?: string; message?: string; to?: string };
      text?: string;
    };
  };
}
