import { and, eq, or, sql } from 'drizzle-orm';

import { projectSessions } from '@kortix/db';
import type { createGateway } from '@kortix/llm-gateway';
import { config } from '../config';
import { logger as appLogger } from '../lib/logger';
import {
  INTERNAL_SESSION_TITLE_KEY_NAME,
  createGatewayKey,
  deleteGatewayKey,
} from '../llm-gateway/gateway-keys';
import { toWireModel } from '../llm-gateway/resolution/effective';
import { db } from '../shared/db';
import { PLACEHOLDER_TITLE_SQL_PATTERN, isPlaceholderOpencodeTitle } from './lib/opencode-title';
import type { ProjectSessionRow } from './lib/serializers';
import { projectSessionMetadataMerge } from './lib/session-metadata-merge';

// Kortix-owned session titles — the single source of `metadata.name`.
//
// The title is generated the moment the first user prompt's text is known
// server-side, which is one of two moments:
//   - create-with-prompt: `body.initial_prompt` (or `body.title_source`) is
//     baked into the sandbox and runs in-guest, so create is its only chance;
//   - first HTTP prompt: sessions created empty (the whole web UI, warm claim,
//     CLI/SDK) carry their first prompt as an OpenCode REST request body.
// One short call to the internal LLM gateway over just that text. Nothing else
// writes `metadata.name`.
//
// Fire-and-forget by contract: idempotent, best-effort, and it never blocks or
// fails the request it hangs off.

const MAX_TITLE_LENGTH = 64;
// OpenAI-compatible reasoning models count hidden reasoning and visible text
// against the same output ceiling. A 24-token ceiling let the managed
// DeepSeek fallback spend every token on reasoning and return empty content.
const TITLE_MAX_TOKENS = 256;

/** Upper bound on the prompt text a title is derived from — and therefore on
 *  the `title_source` a create stores for its own later fallback hooks. */
export const TITLE_SOURCE_MAX_CHARS = 4000;

const TITLE_SYSTEM_PROMPT =
  "You write a concise, specific title for a chat session from the user's first message. " +
  'Reply with ONLY the title: 3 to 6 words, Title Case, no surrounding quotes, no trailing ' +
  'punctuation, and no preamble.';

// Same-process mutual exclusion. Every double-fire the hook set can produce is
// same-process by construction (`continueSession` racing the proxy hook it
// triggers), and
// callers invoke us with `void`, so the body up to the first `await` runs
// synchronously — one entry wins and the rest are dropped before they cost a
// minted key or a billed completion. Cross-process duplicates are left to the
// compare-and-set in `persistTitle`.
const inFlight = new Set<string>();

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

/** Wire form of a prompt-body `model` field, shaped
 *  `{ providerID, modelID }` (opencode's per-send
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

/** Parse the OpenCode prompt body once and read the text and selected model. */
export function extractPromptInfo(
  body: ArrayBuffer | undefined,
  incomingHeaders: Headers,
): PromptInfo {
  const none: PromptInfo = { text: null, model: null };
  if (!body) return none;
  if (!(incomingHeaders.get('content-type') ?? '').toLowerCase().includes('application/json'))
    return none;
  try {
    return promptInfoFromRestBody(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return none;
  }
}

function promptInfoFromRestBody(parsed: unknown): PromptInfo {
  const none: PromptInfo = { text: null, model: null };
  if (!parsed || typeof parsed !== 'object') return none;
  const envelope = parsed as {
    parts?: unknown;
    model?: unknown;
  };
  const blocks = Array.isArray(envelope.parts) ? envelope.parts : [];
  const text =
    (blocks as Array<{ type?: unknown; text?: unknown }>)
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n')
      .trim() || null;
  return { text, model: wireModelFrom(envelope.model) };
}

/** The text a create-time title is derived from: an explicit clean
 *  `title_source` when the caller renders an envelope around the real message
 *  (Slack/Teams/Telegram/email), else the prompt itself. */
export function titleSourceForCreate(body: Record<string, unknown>): string | null {
  const pick = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  return pick(body.title_source) ?? pick(body.initial_prompt) ?? pick(body.initialPrompt);
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
  const rawBody = JSON.stringify(buildSessionTitleRequestBody(model, promptText));
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

export function buildSessionTitleRequestBody(model: string, promptText: string) {
  return {
    model,
    stream: false,
    max_tokens: TITLE_MAX_TOKENS,
    messages: [
      { role: 'system', content: TITLE_SYSTEM_PROMPT },
      { role: 'user', content: promptText.slice(0, TITLE_SOURCE_MAX_CHARS) },
    ],
  };
}

async function loadRow(sessionId: string, projectId: string): Promise<ProjectSessionRow | null> {
  const [row] = await db
    .select()
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  return (row as ProjectSessionRow | undefined) ?? null;
}

/** `metadata->>'<key>'` semantics, in TypeScript: a jsonb scalar reads as text,
 *  a missing key as null. The TS predicate below and the CAS in `persistTitle`
 *  MUST read the row the same way — a `name`/`custom_name` that is not a string
 *  used to pass the TS gate (which ignored it) and then silently fail the
 *  UPDATE, re-billing a doomed title on every prompt for the session's life. */
function metadataText(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** A session still needs a title unless the user named it or a real (non
 *  placeholder) title already exists — matches opencode-title-capture. */
function needsTitle(row: ProjectSessionRow): boolean {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  if (metadataText(metadata, 'custom_name')?.trim()) return false;
  const name = metadataText(metadata, 'name')?.trim();
  return !(name && !isPlaceholderOpencodeTitle(name));
}

/** The clean text a session was created to be titled from — set at create when
 *  the baked `initial_prompt` is a rendered envelope (Slack/Teams/Telegram)
 *  rather than the user's own words. It outranks whatever text a later fallback
 *  hook happens to carry, so a create-hook failure can never leak turn
 *  instructions or workspace/channel ids into a project-visible title. */
function storedTitleSource(row: ProjectSessionRow): string | null {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const ref = typeof metadata.title_source === 'string' ? metadata.title_source.trim() : '';
  return ref || null;
}

/** The platform default, in gateway wire form. */
function platformDefaultModel(): string | null {
  const ref =
    typeof config.LLM_GATEWAY_DEFAULT_MODEL === 'string'
      ? config.LLM_GATEWAY_DEFAULT_MODEL.trim()
      : '';
  return ref ? toWireModel(ref) : null;
}

/**
 * The model to title with when neither the turn nor the session names one —
 * create-with-prompt and every server-side delivery arrive that way, and
 * `metadata.opencode_model` is absent whenever session create resolved no
 * default (free tier or a gateway-disabled project).
 *
 * The account's own default chain first, then the platform default — but ONLY
 * ever a model the gateway will actually serve for this account+project. The
 * unconditional platform default is a trap: it is a MANAGED id, so on a free
 * tier (or a deployment with no managed provider) the gateway refuses it and
 * every prompt pays a mint → doomed completion → revoke, forever, leaving the
 * session untitled anyway. Skipping cheaply is the honest outcome.
 *
 */
async function resolveFallbackModel(
  input: GenerateSessionTitleInput,
  excludedModel?: string,
): Promise<string | null> {
  const [{ getCachedAccountTier }, { tierGrantsAllModels }, resolution] = await Promise.all([
    import('../billing/services/entitlements'),
    import('../billing/services/tiers'),
    import('../llm-gateway/resolution/default-model'),
  ]);
  const scope = {
    userId: input.userId,
    accountId: input.accountId,
    projectId: input.projectId,
    freeModelsOnly: config.KORTIX_BILLING_INTERNAL_ENABLED
      ? !tierGrantsAllModels(await getCachedAccountTier(input.accountId))
      : false,
  };
  const resolved = await resolution.resolveEffectiveModel({ ...scope, explicit: null });
  const candidates = [resolved.model, platformDefaultModel()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const model = toWireModel(candidate);
    if (model === excludedModel) continue;
    if (await resolution.isModelServableForAccount({ ...scope, model })) return model;
  }
  return null;
}

/** The model the session was started with, in gateway wire form. */
function sessionModel(row: ProjectSessionRow): string | null {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const ref = typeof metadata.opencode_model === 'string' ? metadata.opencode_model.trim() : '';
  return ref ? toWireModel(ref) : null;
}

// PostgreSQL's bare `trim()` strips SPACES only; JavaScript's `String.trim()`
// strips the whole ASCII whitespace set. Both sides of the predicate must trim
// the same set, or a `"\nNew session"` reads as a placeholder to `needsTitle`
// and as a real title to the CAS — a permanent, silent, billed no-op loop.
const JS_WHITESPACE = sql.raw("E' \\t\\n\\r\\f\\v'");
const trimmedName = sql`btrim(${projectSessions.metadata}->>'name', ${JS_WHITESPACE})`;
const trimmedCustomName = sql`btrim(${projectSessions.metadata}->>'custom_name', ${JS_WHITESPACE})`;

/**
 * Compare-and-set the title.
 *
 * The `WHERE` carries the whole "still needs a title" predicate, so the UPDATE
 * is first-writer-wins: a loser is a no-op instead of stomping a user rename or
 * a better title that landed in between. The jsonb merge expression evaluates
 * AFTER PostgreSQL takes the row lock, so a title written here can never clobber
 * a concurrent `remote_branch` / `session_start_timeline`
 * write (or be clobbered by one) the way a read-modify-write of the whole
 * metadata object would.
 *
 * Exported for the integration test that exercises the CAS against a real row.
 */
export async function persistTitle(row: ProjectSessionRow, title: string): Promise<void> {
  await db
    .update(projectSessions)
    .set({ metadata: projectSessionMetadataMerge({ name: title }), updatedAt: new Date() })
    .where(
      and(
        eq(projectSessions.sessionId, row.sessionId),
        eq(projectSessions.projectId, row.projectId),
        eq(projectSessions.accountId, row.accountId),
        sql`coalesce(nullif(${trimmedCustomName}, ''), '') = ''`,
        or(
          sql`nullif(${trimmedName}, '') IS NULL`,
          sql`${trimmedName} ~* ${PLACEHOLDER_TITLE_SQL_PATTERN}`,
        ),
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
  fallbackModel?: (
    input: GenerateSessionTitleInput,
    excludedModel?: string,
  ) => Promise<string | null>;
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
  const suppliedText = input.firstPromptText.trim();
  if (!input.sessionId || !input.projectId || !input.accountId || !input.userId || !suppliedText)
    return;
  if (inFlight.has(input.sessionId)) return;
  inFlight.add(input.sessionId);

  const load = options.loadRow ?? loadRow;
  const generate = options.generate ?? generateViaGateway;
  const persist = options.persist ?? persistTitle;
  const mint =
    options.mintKey ??
    (async (accountId, projectId, userId) => {
      const key = await createGatewayKey({
        accountId,
        projectId,
        name: INTERNAL_SESSION_TITLE_KEY_NAME,
        createdBy: userId,
      });
      return { secret: key.secret_key, keyId: key.key_id };
    });
  // DELETE, not revoke: this key exists for exactly one call, and a soft-revoked
  // row per prompt would grow `gateway_api_keys` without bound and drown the
  // project's real keys in its list.
  const revoke =
    options.revokeKey ?? ((projectId, keyId) => deleteGatewayKey(projectId, keyId).then(() => {}));
  const fallbackModel = options.fallbackModel ?? resolveFallbackModel;

  try {
    const row = await load(input.sessionId, input.projectId);
    if (!row || !needsTitle(row)) return;

    // The create-time `title_source` wins over whatever text this hook was
    // handed: a channel session's baked prompt is a rendered envelope, and only
    // create sees the user's actual message.
    const promptText = storedTitleSource(row) ?? suppliedText;

    // Prefer the model the user actually picked for this turn (from the prompt
    // body); the session's stored `opencode_model` is only the boot default and
    // goes stale the moment the model is switched. Both are known-servable —
    // one is being served right now, the other was validated at create — so
    // only the last resort has to prove itself.
    const model =
      input.modelHint?.trim() || sessionModel(row) || (await fallbackModel(input)) || null;
    if (!model) {
      appLogger.warn('[title-generate] no servable model to title with', {
        sessionId: input.sessionId,
      });
      return;
    }

    const minted = await mint(input.accountId, input.projectId, input.userId);
    if (!minted) return;
    let title: string | null = null;
    try {
      title = sanitizeGeneratedTitle(await generate(model, `Bearer ${minted.secret}`, promptText));
      if (!title) {
        const retryModel = await fallbackModel(input, model);
        if (retryModel && retryModel !== model) {
          appLogger.warn('[title-generate] retrying with servable fallback model', {
            sessionId: input.sessionId,
            rejectedModel: model,
            retryModel,
          });
          title = sanitizeGeneratedTitle(
            await generate(retryModel, `Bearer ${minted.secret}`, promptText),
          );
        }
      }
    } finally {
      await revoke(input.projectId, minted.keyId).catch(() => {});
    }
    if (!title) return;

    // Cheap early-out under the freshest row; the UPDATE's compare-and-set is
    // the actual guarantee that a concurrent rename wins.
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
  } finally {
    inFlight.delete(input.sessionId);
  }
}
