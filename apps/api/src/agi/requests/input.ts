/**
 * Request-body validation for the AGI human-request routes.
 *
 * Pure and synchronous, the same contract tasks/input.ts and observations/input.ts
 * set: everything decidable without the database is decided here, so a 23514 from
 * `agi_requests_url_scheme_check` or the need-length constraint can never be the
 * error a client sees.
 */
import type { Parsed } from '../tasks/input';
import {
  REQUEST_NEED_MAX_LENGTH,
  REQUEST_URL_MAX_LENGTH,
  REQUEST_WHY_MAX_LENGTH,
  isRequestKind,
  type RequestKind,
} from './wire';
import { UUID_V4_REGEX } from '../../projects/lib/serializers';

const SESSION_ID_MAX_LENGTH = 255;
const FINGERPRINT_MAX_LENGTH = 255;

export interface CreateRequestFields {
  kind: RequestKind;
  need: string;
  why: string | null;
  url: string | null;
  /** Null means "the route decides" — see resolveResponder. */
  responderUserId: string | null;
  requestedBySessionId: string | null;
  /** Null means "derive one from (task, kind, need)" — idempotency is the
   *  default, not something an agent has to remember. */
  originFingerprint: string | null;
}

/**
 * The minted fill-in link, validated as a LINK.
 *
 * The scheme check is the point and it is a security control, not tidiness: this
 * column is the one field on the request that an agent fills in freely, and the
 * failure it guards against is an agent that misunderstood the flow and pasted
 * the credential itself here — which would then be direct-messaged to a human in
 * plain text. `http(s)` only, parseable by WHATWG, and bounded.
 */
function parseUrl(value: unknown): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: { error: 'Invalid url' } };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > REQUEST_URL_MAX_LENGTH) {
    return { ok: false, error: { error: `url must be at most ${REQUEST_URL_MAX_LENGTH} characters` } };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: { error: 'url must be an http(s) link', code: 'invalid_url' } };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: { error: 'url must be an http(s) link', code: 'invalid_url' } };
  }
  return { ok: true, value: trimmed };
}

export function parseCreateRequestBody(body: Record<string, unknown>): Parsed<CreateRequestFields> {
  if (!isRequestKind(body.kind)) {
    return { ok: false, error: { error: 'kind must be secret, connector, access, or decision' } };
  }

  if (typeof body.need !== 'string') return { ok: false, error: { error: 'need is required' } };
  const need = body.need.trim();
  if (need.length === 0) return { ok: false, error: { error: 'need is required' } };
  if (need.length > REQUEST_NEED_MAX_LENGTH) {
    return { ok: false, error: { error: `need must be at most ${REQUEST_NEED_MAX_LENGTH} characters` } };
  }

  let why: string | null = null;
  if (body.why !== undefined && body.why !== null) {
    if (typeof body.why !== 'string') return { ok: false, error: { error: 'Invalid why' } };
    // Preserved byte for byte apart from the empty check: the "why" is prose a
    // human reads, and its line breaks are meaningful.
    if (body.why.length > REQUEST_WHY_MAX_LENGTH) {
      return { ok: false, error: { error: `why must be at most ${REQUEST_WHY_MAX_LENGTH} characters` } };
    }
    why = body.why.trim().length > 0 ? body.why : null;
  }

  const url = parseUrl(body.url);
  if (!url.ok) return url;

  let responderUserId: string | null = null;
  if (body.responder_user_id !== undefined && body.responder_user_id !== null) {
    if (typeof body.responder_user_id !== 'string' || !UUID_V4_REGEX.test(body.responder_user_id)) {
      return { ok: false, error: { error: 'Invalid responder_user_id' } };
    }
    responderUserId = body.responder_user_id;
  }

  let requestedBySessionId: string | null = null;
  if (body.session_id !== undefined && body.session_id !== null) {
    if (typeof body.session_id !== 'string') {
      return { ok: false, error: { error: 'Invalid session_id' } };
    }
    const trimmed = body.session_id.trim();
    if (trimmed.length === 0 || trimmed.length > SESSION_ID_MAX_LENGTH) {
      return { ok: false, error: { error: 'Invalid session_id' } };
    }
    requestedBySessionId = trimmed;
  }

  let originFingerprint: string | null = null;
  if (body.origin_fingerprint !== undefined && body.origin_fingerprint !== null) {
    if (typeof body.origin_fingerprint !== 'string') {
      return { ok: false, error: { error: 'Invalid origin_fingerprint' } };
    }
    const trimmed = body.origin_fingerprint.trim();
    if (trimmed.length === 0 || trimmed.length > FINGERPRINT_MAX_LENGTH) {
      return { ok: false, error: { error: 'Invalid origin_fingerprint' } };
    }
    originFingerprint = trimmed;
  }

  return {
    ok: true,
    value: { kind: body.kind, need, why, url: url.value, responderUserId, requestedBySessionId, originFingerprint },
  };
}

export interface ResolveRequestFields {
  status: 'satisfied' | 'cancelled';
  note: string | null;
}

/**
 * Closing a request. Two ways out, and they mean different things:
 *
 *   satisfied — the human did the thing. The work can proceed.
 *   cancelled — the ask is withdrawn or moot. The work cannot proceed on the
 *               strength of this request, and the task loses its live path.
 *
 * There is deliberately no way back to `pending`. Re-asking is a NEW request,
 * which is what makes the fingerprint honest: a reopened row would let one ask
 * be delivered once and then silently resurrected forever.
 */
export function parseResolveRequestBody(body: Record<string, unknown>): Parsed<ResolveRequestFields> {
  const status = body.status ?? 'satisfied';
  if (status !== 'satisfied' && status !== 'cancelled') {
    return { ok: false, error: { error: 'status must be satisfied or cancelled' } };
  }

  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') return { ok: false, error: { error: 'Invalid note' } };
    if (body.note.length > REQUEST_WHY_MAX_LENGTH) {
      return { ok: false, error: { error: `note must be at most ${REQUEST_WHY_MAX_LENGTH} characters` } };
    }
    note = body.note.trim().length > 0 ? body.note : null;
  }

  return { ok: true, value: { status, note } };
}
