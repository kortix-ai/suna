import { and, eq } from 'drizzle-orm';

import { projectSessions } from '@kortix/db';
import type { createGateway } from '@kortix/llm-gateway';
import { config } from '../config';
import { logger as appLogger } from '../lib/logger';
import { createGatewayKey, revokeGatewayKey } from '../llm-gateway/gateway-keys';
import { toWireModel } from '../llm-gateway/resolution/effective';
import { db } from '../shared/db';
import { isPlaceholderOpencodeTitle } from './lib/opencode-title';
import type { ProjectSessionRow } from './lib/serializers';

// Kortix-owned session titles — the single source of `metadata.name`.
//
// We generate the title ourselves the moment a session serves its FIRST user
// prompt: one short call to the internal LLM gateway, using the model the user
// actually picked for that turn (from the prompt body), over just the first
// prompt text. Nothing else writes `metadata.name`.
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
// never depend on the pod's URL for our own internal call. Loaded LAZILY: a
// title is fire-and-forget, so importing this module must not drag the whole
// gateway (routing, policy engine, catalog) into every consumer's load graph.
let gatewaySingleton: ReturnType<typeof createGateway> | null = null;
async function internalGateway(): Promise<ReturnType<typeof createGateway>> {
  if (!gatewaySingleton) {
    const { createGateway } = await import('@kortix/llm-gateway');
    const { createInProcessGatewayHooks } = await import('../llm-gateway/hooks');
    gatewaySingleton = createGateway(createInProcessGatewayHooks());
  }
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

export interface PromptInfo {
  /** First user prompt text (all text blocks joined), or null. */
  text: string | null;
  /** The model the user picked for THIS turn in gateway wire form, or null. */
  model: string | null;
}

/** Wire form of a prompt-body `model` field — REST `body.model` or ACP
 *  `body.params.model`, shaped `{ providerID, modelID }` (opencode's per-send
 *  override) or a bare string. opencode's synthetic `kortix` provider already
 *  carries the full gateway wire id in `modelID` (e.g. `codex/gpt-5.6-sol`);
 *  any other provider is a BYOK `provider/model` pair. */
function wireModelFrom(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') return toWireModel(raw.trim()) || null;
  if (typeof raw !== 'object') return null;
  const m = raw as { providerID?: unknown; modelID?: unknown };
  const modelId = typeof m.modelID === 'string' ? m.modelID.trim() : '';
  const providerId = typeof m.providerID === 'string' ? m.providerID.trim() : '';
  if (!modelId) return null;
  return providerId && providerId !== 'kortix' ? `${providerId}/${modelId}` : modelId;
}

/** Parse the prompt-proxy body ONCE and pull out both the first user prompt text
 *  and the live picked model. Handles REST (`{parts, model}`) and ACP
 *  (`{params:{prompt, model}}`) shapes. Both fields null when unreadable. */
export function extractPromptInfo(
  body: ArrayBuffer | undefined,
  incomingHeaders: Headers,
): PromptInfo {
  const none: PromptInfo = { text: null, model: null };
  if (!body) return none;
  if (!(incomingHeaders.get('content-type') ?? '').toLowerCase().includes('application/json'))
    return none;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      parts?: unknown;
      model?: unknown;
      params?: { prompt?: unknown; model?: unknown };
    };
    const blocks = Array.isArray(parsed.parts)
      ? parsed.parts
      : Array.isArray(parsed.params?.prompt)
        ? (parsed.params?.prompt as unknown[])
        : [];
    const text =
      (blocks as Array<{ type?: unknown; text?: unknown }>)
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n')
        .trim() || null;
    return { text, model: wireModelFrom(parsed.model ?? parsed.params?.model) };
  } catch {
    return none;
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
  const gateway = await internalGateway();
  const res = await gateway.chatCompletions({ authorization, rawBody });
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
  /** The model the user actually picked for this turn (gateway wire form, from
   *  the prompt body). Preferred over the session's stale boot-default
   *  `opencode_model`, which goes out of date the moment the model is switched. */
  modelHint?: string;
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

    // Prefer the model the user actually picked for this turn (from the prompt
    // body); the session's stored `opencode_model` is only the boot default and
    // goes stale the moment the model is switched.
    const model = input.modelHint?.trim() || sessionModel(row);
    if (!model) {
      appLogger.warn('[title-generate] no model to title with', {
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
