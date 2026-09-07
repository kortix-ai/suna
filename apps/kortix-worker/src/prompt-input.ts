import { WIRE_MESSAGE_ID, canMintOrderedReplyAfter } from './wire-message-id.ts';

export interface CompiledPromptRuntime {
  agent?: string | null;
  model?: { providerID: string; modelID: string } | null;
}

export interface PromptInput {
  messageID?: string;
  text: string;
  system?: string;
}

export type PromptInputResult = { ok: true; value: PromptInput } | { ok: false; error: string };

const SUPPORTED_FIELDS = new Set(['messageID', 'model', 'agent', 'parts', 'system']);
const SUPPORTED_TEXT_PART_FIELDS = new Set(['type', 'text']);

function own(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

/** Validate the OpenCode prompt body before the worker acknowledges it. */
export function parsePromptInput(
  raw: string,
  runtime: CompiledPromptRuntime,
  nowMs = Date.now(),
): PromptInputResult {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'prompt body must be an object' };
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'invalid json body' };
  }

  for (const field of Object.keys(body)) {
    if (!SUPPORTED_FIELDS.has(field)) {
      return { ok: false, error: `prompt field "${field}" is not supported by the Pi worker` };
    }
  }

  if (own(body, 'system') && typeof body.system !== 'string') {
    return { ok: false, error: 'system must be a string' };
  }

  if (own(body, 'agent')) {
    if (typeof body.agent !== 'string' || !body.agent) {
      return { ok: false, error: 'agent must be a non-empty string' };
    }
    if (!runtime.agent || body.agent !== runtime.agent) {
      return {
        ok: false,
        error: `agent "${body.agent}" is not available in this compiled worker`,
      };
    }
  }

  if (own(body, 'model')) {
    const model = body.model as { providerID?: unknown; modelID?: unknown } | null;
    if (
      !model ||
      typeof model !== 'object' ||
      typeof model.providerID !== 'string' ||
      typeof model.modelID !== 'string'
    ) {
      return { ok: false, error: 'model must contain providerID and modelID strings' };
    }
    const requested = `${model.providerID}/${model.modelID}`;
    if (
      !runtime.model ||
      model.providerID !== runtime.model.providerID ||
      model.modelID !== runtime.model.modelID
    ) {
      return {
        ok: false,
        error: `model "${requested}" is not available in this compiled worker`,
      };
    }
  }

  if (own(body, 'messageID')) {
    if (typeof body.messageID !== 'string' || !body.messageID.trim()) {
      return { ok: false, error: 'messageID must be a non-empty string' };
    }
    if (body.messageID !== body.messageID.trim()) {
      return { ok: false, error: 'messageID must not contain surrounding whitespace' };
    }
    if (!WIRE_MESSAGE_ID.test(body.messageID)) {
      return { ok: false, error: 'messageID must use the OpenCode wire format' };
    }
    if (!canMintOrderedReplyAfter(body.messageID, nowMs)) {
      return { ok: false, error: 'messageID clock is outside the trusted ordering window' };
    }
  }

  if (!Array.isArray(body.parts) || body.parts.length === 0) {
    return { ok: false, error: 'parts must be a non-empty array' };
  }
  const text: string[] = [];
  for (const rawPart of body.parts) {
    if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
      return { ok: false, error: 'prompt parts must be objects' };
    }
    const part = rawPart as { type?: unknown; text?: unknown };
    if (part.type !== 'text') {
      const type = typeof part.type === 'string' ? part.type : 'unknown';
      return {
        ok: false,
        error: `prompt part type "${type}" is not supported by the Pi worker`,
      };
    }
    if (typeof part.text !== 'string') {
      return { ok: false, error: 'text parts require a string text field' };
    }
    for (const field of Object.keys(part)) {
      if (!SUPPORTED_TEXT_PART_FIELDS.has(field)) {
        return {
          ok: false,
          error: `text part field "${field}" is not supported by the Pi worker`,
        };
      }
    }
    text.push(part.text);
  }

  return {
    ok: true,
    value: {
      ...(typeof body.messageID === 'string' ? { messageID: body.messageID } : {}),
      text: text.join(''),
      ...(typeof body.system === 'string' ? { system: body.system } : {}),
    },
  };
}
