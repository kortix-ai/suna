import type { Effect } from 'effect';
import { createRoute, z } from "@hono/zod-openapi";
import { continueSession } from "../projects/session-lifecycle";
import { makeOpenApiApp, json, errors } from "../openapi";
import { MEET_DEFAULT_WAKE, verifyMeetSessionToken } from "./meet-realtime";
import { type MeetTurn, meetConversation } from "./meet-conversation";
import { isBotEcho, isBotSpeaking } from "./meet-echo";
import { playAcknowledgement } from "./meet-tts";
import { effectHandler } from "../effect/hono";

export const meetWebhookApp = makeOpenApiApp();

meetWebhookApp.openapi(
  createRoute({
    method: "post",
    path: "/realtime",
    tags: ["channels"],
    summary: "Recall.ai real-time meeting events (transcript + chat)",
    request: { body: { content: { "application/json": { schema: z.any() } } } },
    responses: {
      200: json(z.object({ ok: z.boolean() }).passthrough(), "Accepted"),
      ...errors(400, 401),
    },
  }),
  effectHandler(async (c: any) => {
    let body: RealtimeEvent;
    try {
      body = (await c.req.json()) as RealtimeEvent;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const meta = (body?.data?.bot?.metadata ?? {}) as Record<string, unknown>;
    const sessionId =
      typeof meta.kortix_session_id === "string" ? meta.kortix_session_id : "";
    const token =
      typeof meta.kortix_token === "string" ? meta.kortix_token : "";
    if (!verifyMeetSessionToken(sessionId, token)) {
      return c.json({ error: "unverified" }, 401);
    }

    const turn = extractTurn(body);
    if (turn?.text) {
      const projectId =
        typeof meta.kortix_project_id === "string"
          ? meta.kortix_project_id
          : "";
      const botId = body?.data?.bot?.id ?? "";
      const botName =
        typeof meta.kortix_bot_name === "string" ? meta.kortix_bot_name : "";

      if (!isSelfEcho(botId, botName, turn)) {
        const wake = (
          typeof meta.kortix_wake === "string"
            ? meta.kortix_wake
            : MEET_DEFAULT_WAKE
        ).toLowerCase();
        meetConversation.ingest({
          sessionId,
          speaker: turn.speaker,
          text: turn.text,
          spoken: turn.spoken,
          wake,
          deliver: (delivered) =>
            deliverTurn({ projectId, sessionId, botId, turn: delivered }),
        });
      }
    }
    return c.json({ ok: true });
  }),
);

meetWebhookApp.openapi(
  createRoute({
    method: "post",
    path: "/status",
    tags: ["channels"],
    summary: "Recall.ai bot lifecycle events (auto-recap on meeting end)",
    request: { body: { content: { "application/json": { schema: z.any() } } } },
    responses: {
      200: json(z.object({ ok: z.boolean() }).passthrough(), "Accepted"),
      ...errors(400, 401),
    },
  }),
  effectHandler(async (c: any) => {
    let body: StatusEvent;
    try {
      body = (await c.req.json()) as StatusEvent;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const meta = (body?.data?.bot?.metadata ?? {}) as Record<string, unknown>;
    const sessionId =
      typeof meta.kortix_session_id === "string" ? meta.kortix_session_id : "";
    const token =
      typeof meta.kortix_token === "string" ? meta.kortix_token : "";
    if (!verifyMeetSessionToken(sessionId, token)) {
      return c.json({ error: "unverified" }, 401);
    }

    const botId = body?.data?.bot?.id ?? "";
    if (body.event === "bot.done" && botId && !alreadyRecapped(botId)) {
      markRecapped(botId);
      void continueSession({
        source: "meet",
        sessionId,
        text: buildRecapPrompt(botId),
        userId: null,
      })
        .then((outcome) => {
          if (outcome === "no-session" || outcome === "failed") {
            console.warn("[meet-webhook] recap", outcome, "session", sessionId);
          }
        })
        .catch((err) => console.error("[meet-webhook] recap failed", err));
    }
    return c.json({ ok: true });
  }),
);

const RECAP_TTL_MS = 6 * 60 * 60 * 1000;
const recapped = new Map<string, number>();

function alreadyRecapped(botId: string): boolean {
  const now = Date.now();
  for (const [id, at] of recapped)
    if (now - at > RECAP_TTL_MS) recapped.delete(id);
  return recapped.has(botId);
}

function markRecapped(botId: string): void {
  recapped.set(botId, Date.now());
}

export function buildRecapPrompt(botId: string): string {
  return [
    `The meeting just ended (bot id ${botId}). Produce the meeting notes now.`,
    "",
    `1. Pull the full transcript: \`meet transcript ${botId}\`. If it reports "processing", wait ~20s and retry once or twice — captions finalize shortly after the call ends.`,
    `2. From the transcript, write a concise recap:`,
    `   - TL;DR — one or two sentences on what the meeting covered and the outcome.`,
    `   - Decisions — what was actually decided.`,
    `   - Action items — a checklist of owner → task, with due dates where mentioned.`,
    `   - Open questions — anything left unresolved.`,
    "",
    `Deliver the recap as your reply. If the transcript is empty (no speech was captured), say that plainly instead of inventing content.`,
  ].join("\n");
}

function deliverTurn(args: {
  projectId: string;
  sessionId: string;
  botId: string;
  turn: MeetTurn;
}): void {
  const { projectId, sessionId, botId, turn } = args;

  if (turn.spoken && projectId && botId) {
    void playAcknowledgement(projectId, botId).catch((err) =>
      console.error("[meet-webhook] acknowledgement failed", err),
    );
  }

  void continueSession({
    source: "meet",
    sessionId,
    text: buildWakePrompt({ ...turn, botId }),
    userId: null,
  })
    .then((outcome) => {
      if (outcome === "no-session" || outcome === "failed") {
        console.warn("[meet-webhook] delivery", outcome, "session", sessionId);
      }
    })
    .catch((err) => console.error("[meet-webhook] deliver failed", err));
}

export function isSelfEcho(
  botId: string,
  botName: string,
  turn: { speaker: string; text: string; spoken: boolean },
): boolean {
  // Primary guard: while the bot is speaking, captions stream its own output audio
  // back as "Unknown" speech — drop all inbound speech for that window. Chat is
  // never echoed this way, so it's exempt.
  if (turn.spoken && isBotSpeaking(botId)) return true;
  // Fallbacks for stragglers past the window: content match, and the bot's own
  // chat message (attributed to its name).
  if (isBotEcho(botId, turn.text)) return true;
  if (
    botName &&
    turn.speaker &&
    turn.speaker.toLowerCase() === botName.toLowerCase()
  )
    return true;
  return false;
}

export function buildWakePrompt(turn: {
  speaker: string;
  text: string;
  spoken: boolean;
  botId: string;
}): string {
  const verb = turn.spoken ? "said (spoken)" : "wrote in the chat";
  const replyLine = turn.spoken
    ? [
        `They SPOKE to you out loud, so you MUST reply by VOICE — run \`meet speak\`, NEVER \`meet chat\`.`,
        `This is a spoken conversation: speak EVERY reply aloud, even a short one, even a list of points. Do not type in the chat.`,
        `  meet speak ${turn.botId} "<your reply>"`,
        `Plain spoken words only — no markdown, no bullet lists, no URLs read aloud. If you truly must share a link or file, speak your answer AND additionally drop the link with \`meet chat\` — but always speak.`,
      ].join("\n")
    : `They TYPED in the chat, so reply IN THE CHAT:\n  meet chat ${turn.botId} "<your reply>"`;
  return [
    `[Live meeting] ${turn.speaker} ${verb}: "${turn.text}"`,
    "",
    `You're live in this meeting (bot id ${turn.botId}) and were just addressed. They can keep talking to you for a moment without repeating your name, so stay in the conversation.`,
    replyLine,
    `Keep it to a sentence or two — you're in a live call. If no reply is actually needed, do nothing.`,
  ].join("\n");
}

export function extractTurn(
  body: RealtimeEvent,
): { speaker: string; text: string; spoken: boolean } | null {
  const inner = body?.data?.data ?? {};
  const speaker = (inner.participant?.name as string) || "Someone";
  if (body.event === "transcript.data") {
    const text = (inner.words ?? [])
      .map((w) => w?.text ?? "")
      .join(" ")
      .trim();
    return { speaker, text, spoken: true };
  }
  if (body.event === "participant_events.chat_message") {
    const chat = inner.data ?? {};
    const text = String(chat.text ?? chat.message ?? inner.text ?? "").trim();
    return { speaker, text, spoken: false };
  }
  return null;
}

interface StatusEvent {
  event: string;
  data?: {
    bot?: { id?: string; metadata?: Record<string, unknown> };
  };
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
