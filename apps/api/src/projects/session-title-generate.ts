import { and, eq } from 'drizzle-orm';

import { projectSessions } from '@kortix/db';
import { createGateway } from '@kortix/llm-gateway';
import { config } from '../config';
import { logger as appLogger } from '../lib/logger';
import { createGatewayKey, revokeGatewayKey } from '../llm-gateway/gateway-keys';
import { createInProcessGatewayHooks } from '../llm-gateway/hooks';
import { toWireModel } from '../llm-gateway/resolution/effective';
import { db } from '../shared/db';
import type { ProjectSessionRow } from './lib/serializers';
import { isPlaceholderOpencodeTitle } from './opencode-title-sync';

// Kortix-owned session titles.
//
// Historically a session's title came from OpenCode's in-sandbox summarizer,
// mirrored into `metadata.name` by opencode-title-*. That path is fragile: it
// depends on the summarizer succeeding in the sandbox and on the box being
// awake when the deferred capture polls it, so long/failed/large sessions never
// got a title and stayed the frozen "New session" placeholder.
//
// Instead we generate the title ourselves the moment a session serves its FIRST
// user prompt: one short call to the internal LLM gateway, using the model the
// session was started with, over just the first prompt text. It is the
// authoritative source; the OpenCode sync is now a fallback that never
// overwrites a real title (see opencode-title-sync / opencode-title-capture).
//
// Fire-and-forget by contract: idempotent, best-effort, and it never blocks or
// fails the prompt request.

const MAX_TITLE_LENGTH = 64;
const MAX_PROMPT_CHARS = 4000;
const TITLE_MAX_TOKENS = 24;

const TITLE_SYSTEM_PROMPT =
  "You write a concise, specific title for a chat session from the user's first message. " +
  'Reply with ONLY the title: 3 to 6 words, Title Case, no surrounding quotes, no trailing ' +
  'punctuation, and no preamble.';

// The same pipeline the API mounts, run directly in-process so title generation
// behaves identically whether the gateway is in-process or a standalone pod — we
// never depend on the pod's URL for our own internal call.
let gatewaySingleton: ReturnType<typeof createGateway> | null = null;
function internalGateway(): ReturnType<typeof createGateway> {
  if (!gatewaySingleton) gatewaySingleton = createGateway(createInProcessGatewayHooks());
  return gatewaySingleton;
}

/** Normalize a model-generated title: strip wrapping quotes, collapse
 *  whitespace, bound the length, and reject a placeholder-shaped result. */
export function sanitizeGeneratedTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let title = raw.replace(/[\r\n]+/g, ' ').trim();
  title = title
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '')
    .trim();
  title = title.replace(/\s+/g, ' ');
  if (!title) return null;
  if (title.length > MAX_TITLE_LENGTH) title = title.slice(0, MAX_TITLE_LENGTH).trim();
  if (!title || isPlaceholderOpencodeTitle(title)) return null;
  return title;
}

/** First user prompt text from a REST (`{parts}`) or ACP (`{params:{prompt}}`)
 *  body — the two content-block shapes the sandbox prompt proxy forwards. */
export function extractFirstPromptText(
  body: ArrayBuffer | undefined,
  incomingHeaders: Headers,
): string | null {
  if (!body) return null;
  if (!(incomingHeaders.get('content-type') ?? '').toLowerCase().includes('application/json'))
    return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      parts?: unknown;
      params?: { prompt?: unknown };
    };
    const blocks = Array.isArray(parsed.parts)
      ? parsed.parts
      : Array.isArray(parsed.params?.prompt)
        ? (parsed.params?.prompt as unknown[])
        : null;
    if (!blocks) return null;
    const text = (blocks as Array<{ type?: unknown; text?: unknown }>)
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n')
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

function contentToString(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : '',
      )
      .join('');
  }
  return null;
}

async function generateViaGateway(
  model: string,
  authorization: string,
  promptText: string,
): Promise<string | null> {
  const rawBody = JSON.stringify({
    model,
    stream: false,
    max_tokens: TITLE_MAX_TOKENS,
    messages: [
      { role: 'system', content: TITLE_SYSTEM_PROMPT },
      { role: 'user', content: promptText.slice(0, MAX_PROMPT_CHARS) },
    ],
  });
  const res = await internalGateway().chatCompletions({ authorization, rawBody });
  if (!res.ok) {
    appLogger.warn('[title-generate] gateway returned non-200', { status: res.status, model });
    return null;
  }
  const data = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  return contentToString(data?.choices?.[0]?.message?.content);
}

async function loadRow(sessionId: string, projectId: string): Promise<ProjectSessionRow | null> {
  const [row] = await db
    .select()
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  return (row as ProjectSessionRow | undefined) ?? null;
}

/** A session still needs a title unless the user named it or a real (non
 *  placeholder) title already exists — matches opencode-title-capture. */
function needsTitle(row: ProjectSessionRow): boolean {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata.custom_name === 'string' && metadata.custom_name.trim()) return false;
  const name = typeof metadata.name === 'string' ? metadata.name : null;
  return !(name && !isPlaceholderOpencodeTitle(name));
}

/** The model the session was started with, in gateway wire form. */
function sessionModel(row: ProjectSessionRow): string | null {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const ref = typeof metadata.opencode_model === 'string' ? metadata.opencode_model.trim() : '';
  return ref ? toWireModel(ref) : null;
}

async function persistTitle(row: ProjectSessionRow, title: string): Promise<void> {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  await db
    .update(projectSessions)
    .set({ metadata: { ...metadata, name: title }, updatedAt: new Date() })
    .where(
      and(
        eq(projectSessions.sessionId, row.sessionId),
        eq(projectSessions.projectId, row.projectId),
        eq(projectSessions.accountId, row.accountId),
      ),
    );
}

export interface GenerateSessionTitleInput {
  sessionId: string;
  projectId: string;
  accountId: string;
  userId: string;
  firstPromptText: string;
}

/** Injectable seams so unit tests run without process-global module mocks. */
export interface GenerateSessionTitleOptions {
  loadRow?: (sessionId: string, projectId: string) => Promise<ProjectSessionRow | null>;
  generate?: (model: string, authorization: string, promptText: string) => Promise<string | null>;
  mintKey?: (
    accountId: string,
    projectId: string,
    userId: string,
  ) => Promise<{ secret: string; keyId: string } | null>;
  revokeKey?: (projectId: string, keyId: string) => Promise<void>;
  persist?: (row: ProjectSessionRow, title: string) => Promise<void>;
}

/**
 * Generate a session's title from its FIRST user prompt via the internal LLM
 * gateway (using the session's own model) and persist it to `metadata.name`.
 * Authoritative and Kortix-owned. Fire-and-forget: idempotent, best-effort,
 * never blocks or fails the prompt.
 */
export async function generateSessionTitleFromFirstPrompt(
  input: GenerateSessionTitleInput,
  options: GenerateSessionTitleOptions = {},
): Promise<void> {
  if (!config.SESSION_TITLE_GENERATION_ENABLED) return;
  const promptText = input.firstPromptText.trim();
  if (!input.sessionId || !input.projectId || !input.accountId || !input.userId || !promptText)
    return;

  const load = options.loadRow ?? loadRow;
  const generate = options.generate ?? generateViaGateway;
  const persist = options.persist ?? persistTitle;
  const mint =
    options.mintKey ??
    (async (accountId, projectId, userId) => {
      const key = await createGatewayKey({
        accountId,
        projectId,
        name: 'internal-session-title',
        createdBy: userId,
      });
      return { secret: key.secret_key, keyId: key.key_id };
    });
  const revoke =
    options.revokeKey ?? ((projectId, keyId) => revokeGatewayKey(projectId, keyId).then(() => {}));

  try {
    const row = await load(input.sessionId, input.projectId);
    if (!row || !needsTitle(row)) return;

    const model = sessionModel(row);
    if (!model) {
      appLogger.warn('[title-generate] no session model to title with', {
        sessionId: input.sessionId,
      });
      return;
    }

    const minted = await mint(input.accountId, input.projectId, input.userId);
    if (!minted) return;
    let title: string | null = null;
    try {
      title = sanitizeGeneratedTitle(await generate(model, `Bearer ${minted.secret}`, promptText));
    } finally {
      await revoke(input.projectId, minted.keyId).catch(() => {});
    }
    if (!title) return;

    // Re-check under the freshest row so a concurrent rename / capture wins.
    const fresh = await load(input.sessionId, input.projectId);
    if (!fresh || !needsTitle(fresh)) return;
    await persist(fresh, title);
    appLogger.info('[title-generate] titled session from first prompt', {
      sessionId: input.sessionId,
      title,
    });
  } catch (err) {
    appLogger.warn('[title-generate] failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
