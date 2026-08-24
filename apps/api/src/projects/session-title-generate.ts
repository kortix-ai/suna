import { and, eq, or, sql } from 'drizzle-orm';

import { projectSessions } from '@kortix/db';
import { config } from '../config';
import { logger as appLogger } from '../lib/logger';
import {
  INTERNAL_SESSION_TITLE_KEY_NAME,
  createGatewayKey,
  deleteGatewayKey,
} from '../llm-gateway/gateway-keys';
import { toWireModel } from '../llm-gateway/resolution/effective';
import { projectLlmGatewayEnabledById } from '../llm-gateway/enablement';
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
// At most two bounded calls to the internal LLM gateway use only that text. A
// deterministic prompt excerpt guarantees a title when both calls fail.
// Nothing else writes `metadata.name`.
//
// Fire-and-forget by contract: idempotent, best-effort, and it never blocks or
// fails the request it hangs off.

const MAX_TITLE_LENGTH = 64;
const DEFAULT_GENERATION_TIMEOUT_MS = 15_000;
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

function standaloneGatewayUrl(): string | null {
  const target =
    config.LLM_GATEWAY_PROXY_TARGET ||
    (config.LLM_GATEWAY_PROXY_PORT
      ? `http://127.0.0.1:${config.LLM_GATEWAY_PROXY_PORT}`
      : '');
  if (!target) return null;
  try {
    const url = new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${target.replace(/\/+$/, '')}/v1/chat/completions`;
  } catch {
    return null;
  }
}

/** Normalize a model-generated title: strip wrapping quotes, collapse
 *  whitespace, bound the length, and reject a placeholder-shaped result. */
export function sanitizeGeneratedTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // A code fence means the model answered the message instead of titling it —
  // never let a task attempt become a project-visible session name.
  if (raw.includes('```')) return null;
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

/** Last-resort title when every configured model fails. Keep the first prompt
 * recognizable, but bound it to a sidebar-sized phrase. */
function deterministicTitleFromPrompt(raw: string): string | null {
  const normalized = raw
    .replace(/^[\s#>*`"'-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  const words = normalized.split(' ');
  let candidate = '';
  for (const word of words.slice(0, 8)) {
    const next = candidate ? `${candidate} ${word}` : word;
    if (next.length > MAX_TITLE_LENGTH) break;
    candidate = next;
  }
  if (!candidate) candidate = normalized.slice(0, MAX_TITLE_LENGTH);
  candidate = candidate.replace(/[\s.,!?;:'"`-]+$/, '').trim();
  if (!candidate) return null;
  if (isPlaceholderOpencodeTitle(candidate)) candidate = `Topic: ${candidate}`;
  return sanitizeGeneratedTitle(candidate);
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

/** The completion request a title is generated with (exported for tests —
 *  the `max_tokens` floor is load-bearing, see TITLE_MAX_TOKENS). */
export function titleCompletionBody(model: string, promptText: string): string {
  // The first message is DATA, not a request: passed bare, smaller models
  // ignore the system prompt and start performing the task (emitting code
  // for "create a demo PDF…"). Quoting it inside an explicit titling
  // instruction in the user turn keeps them on task.
  const userContent =
    'Write the title for a chat session whose first message follows between the markers. ' +
    'Do NOT answer or perform the message — only title it.\n' +
    `<<<FIRST_MESSAGE\n${promptText.slice(0, TITLE_SOURCE_MAX_CHARS)}\nFIRST_MESSAGE\n>>>` +
    '\nReply with ONLY the title: 3 to 6 words, Title Case.';
  return JSON.stringify({
    model,
    stream: false,
    max_tokens: TITLE_MAX_TOKENS,
    messages: [
      { role: 'system', content: TITLE_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  });
}
async function generateViaGateway(
  model: string,
  authorization: string,
  promptText: string,
): Promise<string | null> {
  const rawBody = titleCompletionBody(model, promptText);
  const gatewayUrl = standaloneGatewayUrl();
  if (!gatewayUrl) {
    appLogger.warn('[title-generate] standalone gateway is not configured');
    return null;
  }
  const res = await fetch(gatewayUrl, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: rawBody,
    signal: AbortSignal.timeout(DEFAULT_GENERATION_TIMEOUT_MS),
  });
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
 * every prompt pays a mint → doomed completion → revoke. The caller skips that
 * spend and persists its deterministic prompt excerpt instead.
 *
 */
async function resolveFallbackModel(
  input: GenerateSessionTitleInput,
  excludedModel?: string,
): Promise<string | null> {
  const [{ accountMayUseManagedModels }, resolution] = await Promise.all([
    import('../billing/services/entitlements'),
    import('../llm-gateway/resolution/default-model'),
  ]);
  const scope = {
    userId: input.userId,
    accountId: input.accountId,
    projectId: input.projectId,
    freeModelsOnly: !(await accountMayUseManagedModels(input.accountId)),
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
  generationTimeoutMs?: number;
  /** The project's `llm_gateway` mode (defaults to the DB read). Off ⇒ no
   *  gateway pipeline runs and the deterministic prompt excerpt titles the
   *  session. */
  resolveLlmGatewayEnabled?: (projectId: string) => Promise<boolean>;
}

async function generateWithDeadline(
  generate: NonNullable<GenerateSessionTitleOptions['generate']>,
  model: string,
  authorization: string,
  promptText: string,
  sessionId: string,
  timeoutMs: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, Math.max(1, timeoutMs));
    });
    const result = await Promise.race([generate(model, authorization, promptText), timeout]);
    if (timedOut) {
      appLogger.warn('[title-generate] model attempt timed out', { sessionId, model, timeoutMs });
    }
    return result;
  } catch (err) {
    appLogger.warn('[title-generate] model attempt failed', {
      sessionId,
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const generationTimeoutMs = options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;

  try {
    const row = await load(input.sessionId, input.projectId);
    if (!row || !needsTitle(row)) return;

    // The create-time `title_source` wins over whatever text this hook was
    // handed: a channel session's baked prompt is a rendered envelope, and only
    // create sees the user's actual message.
    const promptText = storedTitleSource(row) ?? suppliedText;

    // Two paths on the project's `llm_gateway` flag. Gateway OFF ⇒ this hook
    // runs NO gateway pipeline at all — no key mint, no resolution, no usage
    // event; the deterministic prompt-excerpt below is the title. (In native
    // mode the session's model ref is a native `provider/model` id the
    // in-process gateway cannot serve, and titling through the gateway would
    // be exactly the traffic the flag turns off.)
    const llmGatewayEnabled = await (options.resolveLlmGatewayEnabled ?? projectLlmGatewayEnabledById)(
      input.projectId,
    );

    // Prefer the model the user actually picked for this turn (from the prompt
    // body); the session's stored `opencode_model` is only the boot default and
    // goes stale the moment the model is switched. Both are known-servable —
    // one is being served right now, the other was validated at create — so
    // only the last resort has to prove itself.
    const model = llmGatewayEnabled
      ? input.modelHint?.trim() || sessionModel(row) || (await fallbackModel(input)) || null
      : null;
    let title: string | null = null;
    if (!model) {
      if (llmGatewayEnabled) {
        appLogger.warn('[title-generate] no servable model to title with', {
          sessionId: input.sessionId,
        });
      }
    } else {
      const minted = await mint(input.accountId, input.projectId, input.userId);
      if (minted) {
        try {
          title = sanitizeGeneratedTitle(
            await generateWithDeadline(
              generate,
              model,
              `Bearer ${minted.secret}`,
              promptText,
              input.sessionId,
              generationTimeoutMs,
            ),
          );
          if (!title) {
            const retryModel = await fallbackModel(input, model);
            if (retryModel && retryModel !== model) {
              appLogger.warn('[title-generate] retrying with servable fallback model', {
                sessionId: input.sessionId,
                rejectedModel: model,
                retryModel,
              });
              title = sanitizeGeneratedTitle(
                await generateWithDeadline(
                  generate,
                  retryModel,
                  `Bearer ${minted.secret}`,
                  promptText,
                  input.sessionId,
                  generationTimeoutMs,
                ),
              );
            }
          }
        } finally {
          await revoke(input.projectId, minted.keyId).catch(() => {});
        }
      }
    }
    if (!title) {
      title = deterministicTitleFromPrompt(promptText);
      if (title) {
        appLogger.warn('[title-generate] using deterministic prompt fallback', {
          sessionId: input.sessionId,
        });
      }
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
