import type {
  AdmitResult,
  AuthedPrincipal,
  AuthorizeResult,
  GatewayHooks,
  GatewayLogger,
  TokenCounts,
  UpstreamDescriptor,
} from '../domain';
import { GatewayResolutionError } from '../errors';
import type { FetchImpl } from '../http';
import { upstreamHeaders } from '../http/call-upstream';
import { trimTrailingSlash } from '../transports/ai-sdk/model';
import { upstreamFetch } from '../upstream-fetch';
import { calculateCost } from '../usage/pricing';
import { clampRetryAfterSeconds, gatewayErrorResponse } from './error-response';
import { shownModel, shownProvider } from './public-identity';
import { type HandlerRuntime, authorize, bearer, identity, refundHold, requestId } from './simple-handler';
import { type TraceEmitter, type TraceFields, createTraceEmitter } from './trace';

export type AudioOperation = 'transcriptions' | 'speech';

export interface AudioRequest {
  authorization: string | undefined;
  operation: AudioOperation;
  /** multipart/form-data for transcriptions, JSON for speech. */
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  signal?: AbortSignal;
  /** Test seam: the whole request's budget. Default `AUDIO_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface VoicesRequest {
  authorization: string | undefined;
  /** The speech model whose voices to list: it selects the upstream. */
  model: string;
  signal?: AbortSignal;
}

/** Platinum ends every audio request at 60 s; this bounds only a connection that hangs. */
const AUDIO_TIMEOUT_MS = 120_000;
/** The upstream's price for one speech request, in USD. Never relayed. */
const SPEECH_COST_HEADER = 'x-platinum-cost';
const TRANSCRIPTION_FORMATS = ['json', 'verbose_json', 'text'] as const;
type TranscriptionFormat = (typeof TRANSCRIPTION_FORMATS)[number];
/** Forwarded besides `file`, `model` and `response_format`; every other field is dropped. */
const TRANSCRIPTION_FIELDS = ['language', 'prompt', 'temperature'];
const SPEECH_FORMATS = ['pcm', 'mp3'];
const NO_TOKENS: TokenCounts = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
const WHAT: Record<AudioOperation, string> = { transcriptions: 'transcription', speech: 'speech' };

type Input =
  | { operation: 'transcriptions'; form: FormData; format: TranscriptionFormat }
  | { operation: 'speech'; body: Record<string, unknown> };

/** `model` is read before every other field, so admission can resolve it while another field is wrong. */
type Parsed = { model: string; input: Input } | { model: string; error: string };

interface Refusal {
  status: number;
  code: string;
  message: string;
  suggestion: string;
  retryAfter?: number;
}

/** One request's state, shared by its steps. */
interface Run {
  hooks: GatewayHooks;
  logger: GatewayLogger;
  fetchImpl: FetchImpl;
  id: string;
  emit: TraceEmitter;
  operation: AudioOperation;
  principal: AuthedPrincipal;
  model: string;
  descriptor?: UpstreamDescriptor;
  clientSignal?: AbortSignal;
  signal: AbortSignal;
}

type Named = Pick<Run, 'id' | 'model'> & { descriptor?: UpstreamDescriptor };

const present = (value: unknown) => value !== undefined && value !== null;

async function transcriptionInput(req: AudioRequest): Promise<Parsed> {
  let form: FormData;
  try {
    if (!/^multipart\/form-data\b/i.test(req.contentType)) throw new Error('not multipart');
    form = await new Response(req.body, { headers: { 'content-type': req.contentType } }).formData();
  } catch {
    return { model: '', error: 'Send a multipart/form-data body with `file` and `model`.' };
  }
  const model = form.get('model');
  if (typeof model !== 'string' || !model) return { model: '', error: '`model` is required.' };
  const file = form.get('file');
  if (!(file instanceof Blob)) return { model, error: '`file` is required.' };
  const format = form.get('response_format') ?? 'json';
  if (!TRANSCRIPTION_FORMATS.includes(format as TranscriptionFormat)) {
    return { model, error: '`response_format` must be json, verbose_json or text.' };
  }
  const out = new FormData();
  out.append('file', file);
  for (const field of TRANSCRIPTION_FIELDS) {
    const value = form.get(field);
    if (typeof value === 'string') out.append(field, value);
  }
  // A text answer carries no usage, so it cannot be billed: the upstream
  // answers json, and the gateway returns its text.
  out.append('response_format', format === 'text' ? 'json' : (format as string));
  return { model, input: { operation: 'transcriptions', form: out, format: format as TranscriptionFormat } };
}

function speechInput(req: AudioRequest): Parsed {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(req.body));
  } catch {
    // answered below
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { model: '', error: 'Invalid JSON body' };
  const { model, input, voice, response_format: format, sample_rate: rate, speed } = parsed as Record<string, unknown>;
  if (typeof model !== 'string' || !model) return { model: '', error: '`model` is required.' };
  if (typeof input !== 'string' || !input.trim()) return { model, error: '`input` is required.' };
  if (typeof voice !== 'string' || !voice.trim()) return { model, error: '`voice` is required.' };
  if (present(format) && !SPEECH_FORMATS.includes(format as string)) {
    return { model, error: '`response_format` must be pcm or mp3.' };
  }
  if (present(rate) && !(Number.isInteger(rate) && (rate as number) >= 8_000 && (rate as number) <= 48_000)) {
    return { model, error: '`sample_rate` must be an integer from 8000 to 48000.' };
  }
  if (present(speed) && !(typeof speed === 'number' && speed >= 0.5 && speed <= 1.5)) {
    return { model, error: '`speed` must be from 0.5 to 1.5.' };
  }
  const body: Record<string, unknown> = { input, voice };
  if (present(format)) body.response_format = format;
  if (present(rate)) body.sample_rate = rate;
  if (present(speed)) body.speed = speed;
  return { model, input: { operation: 'speech', body } };
}

/**
 * Only Kortix's managed upstream (Platinum Inference) serves audio: each of
 * its answers states the price the request is billed at.
 */
function servesAudio(descriptor: UpstreamDescriptor): boolean {
  return descriptor.provider === 'platinum' && descriptor.billingMode === 'credits';
}

function errorResponse(at: Named, refusal: Refusal): Response {
  return gatewayErrorResponse(refusal.status, {
    message: refusal.message,
    code: refusal.code,
    provider: at.descriptor ? shownProvider(at.descriptor) : '',
    requestedModel: at.model,
    resolvedModel: at.model,
    requestId: at.id,
    suggestion: refusal.suggestion,
    retryAfterSeconds: refusal.retryAfter,
  });
}

function trace(run: Run, fields: TraceFields): void {
  const { descriptor } = run;
  run.emit({
    ...identity(run.principal),
    requestedModel: run.model,
    resolvedModel: run.model,
    provider: descriptor ? shownProvider(descriptor) : '',
    billingMode: descriptor?.billingMode ?? 'none',
    streaming: run.operation === 'speech',
    attempts: descriptor ? 1 : 0,
    candidatesTried: descriptor ? [`${shownProvider(descriptor)}:${run.model}`] : [],
    ...(descriptor?.publicProvider
      ? { upstream: { provider: descriptor.provider, model: descriptor.resolvedModel ?? run.model } }
      : {}),
    ...fields,
    // Never the audio, the text or the transcript.
    request: null,
    response: null,
    metadata: { operation: `audio.${run.operation}` },
  });
}

/** Every unanswered exit after admission: return any wallet hold, trace, answer. */
function refuse(run: Run, refusal: Refusal): Response {
  refundHold(run.hooks, run.principal, run.logger);
  trace(run, { status: refusal.status, ok: false, errorCode: refusal.code, errorMessage: refusal.message });
  return errorResponse(run, refusal);
}

/** A stopped client or the request's time budget ends it. */
function stopped(run: Pick<Run, 'clientSignal' | 'signal'>): Refusal | null {
  if (run.clientSignal?.aborted) {
    return { status: 499, code: 'client_aborted', message: 'The client cancelled the request.', suggestion: 'Retry the request.' };
  }
  if (run.signal.aborted) {
    return { status: 504, code: 'audio_timeout', message: 'The audio request timed out.', suggestion: 'Retry the request.' };
  }
  return null;
}

function unreachable(at: Named): Refusal {
  return { status: 503, code: 'model_unavailable', message: `${at.model} is temporarily unavailable.`, suggestion: 'Retry in a few seconds.' };
}

function upstreamError(message: string): Refusal {
  return { status: 502, code: 'audio_upstream_error', message, suggestion: 'Retry the request.' };
}

/**
 * What the client hears when the upstream refused. A managed model's upstream
 * text never reaches the client (public identity): it goes to the server log.
 */
async function upstreamRefusal(at: Named & { logger: GatewayLogger; operation: AudioOperation }, response: Response): Promise<Refusal> {
  const detail = await response.text().catch(() => '');
  at.logger.warn(`[gateway] ${at.id}: ${at.descriptor?.provider} audio ${response.status} for ${at.model}: ${detail.slice(0, 300)}`);
  const { status } = response;
  if (status === 429) {
    return {
      status: 429,
      code: 'model_busy',
      message: `${at.model} is at capacity right now.`,
      suggestion: 'Retry in a few seconds.',
      retryAfter: clampRetryAfterSeconds(response.headers.get('retry-after')),
    };
  }
  // A model the upstream does not serve for this operation: a speech model
  // asked to transcribe, or a chat model.
  if (status === 404) {
    return {
      status: 400,
      code: 'model_not_found',
      message: `Kortix does not serve ${at.model} for ${WHAT[at.operation]}.`,
      suggestion: 'Choose a Kortix audio model.',
    };
  }
  // 401, 402 and 403 refuse Kortix's own key: nothing the client can change.
  if (status >= 400 && status < 500 && ![401, 402, 403].includes(status)) {
    return { status: 400, code: 'invalid_request', message: `${at.model} rejected this request.`, suggestion: 'Check the request fields, then retry.' };
  }
  return unreachable(at);
}

/** Admission, as chat takes it: one `admit` round trip when the host offers it, else `authorize`. */
async function admit(
  runtime: HandlerRuntime,
  token: string,
  parsed: Parsed,
  at: Named,
  emit: TraceEmitter,
): Promise<{ admission: AuthorizeResult; prefetched: AdmitResult | null } | Response> {
  const { hooks, logger } = runtime;
  try {
    const prefetched = 'input' in parsed && hooks.admit
      ? await hooks.admit(token, { requestedModel: parsed.model, requires: { imageInput: false } })
      : null;
    if (prefetched?.timing) emit.admitSteps(prefetched.timing);
    return { admission: prefetched?.admission ?? (await authorize(hooks, token)), prefetched };
  } catch (error) {
    logger.error(`[gateway] ${at.id}: admission control unavailable — ${error instanceof Error ? error.message : String(error)}`);
    return errorResponse(at, {
      status: 503,
      code: 'admission_unavailable',
      message: 'Gateway admission control is unavailable',
      suggestion: 'Retry the request.',
      retryAfter: 5,
    });
  }
}

/** The model's upstream, from the admit answer or `resolveUpstream`. */
async function resolve(run: Run, prefetched: AdmitResult | null): Promise<UpstreamDescriptor | Refusal> {
  let candidates: UpstreamDescriptor[];
  try {
    const answered = prefetched?.upstream;
    if (answered instanceof Error) throw answered;
    candidates = answered ?? (await run.hooks.resolveUpstream(run.principal, run.model));
  } catch (error) {
    if (error instanceof GatewayResolutionError) {
      return { status: 400, code: error.code, message: error.message, suggestion: error.suggestion };
    }
    run.logger.error(`[gateway] ${run.id}: audio resolution unavailable — ${error instanceof Error ? error.message : String(error)}`);
    return { status: 502, code: 'routing_unavailable', message: 'Model routing is unavailable', suggestion: 'Retry the request.' };
  }
  run.emit.mark('resolved');
  const descriptor = candidates[0];
  if (!descriptor || !servesAudio(descriptor)) {
    return {
      status: 400,
      code: 'audio_model_unsupported',
      message: `Kortix does not serve ${run.model} for ${WHAT[run.operation]}.`,
      suggestion: 'Choose a Kortix audio model.',
    };
  }
  return descriptor;
}

/** The wallet admission for this Kortix-billed request: the admit answer, else `assertBillingActive`. */
async function charge(run: Run, prefetched: AdmitResult | null): Promise<Refusal | null> {
  if (run.principal.billingHold) return null;
  try {
    const answered = prefetched?.billing;
    if (answered instanceof Error) throw answered;
    const billing = answered ?? (await run.hooks.assertBillingActive(run.principal.accountId));
    if (billing?.holdUsd) run.principal = { ...run.principal, billingHold: { amountUsd: billing.holdUsd } };
    run.emit.mark('billed');
    return null;
  } catch (error) {
    const reason = (error as { reason?: unknown })?.reason;
    return {
      status: 402,
      code: typeof reason === 'string' ? reason : 'subscription_required',
      message: error instanceof Error ? error.message : 'Billing inactive',
      suggestion: 'Check your subscription or add credits, then retry.',
    };
  }
}

/** The upstream's reported price (USD) with the managed markup, or null when it reported none. */
function priced(run: Run, reported: unknown): { upstreamCost: number; finalCost: number } | null {
  const descriptor = run.descriptor!;
  const cost = typeof reported === 'number' ? reported : typeof reported === 'string' && reported.trim() ? Number(reported) : Number.NaN;
  const breakdown = calculateCost(
    descriptor.resolvedModel ?? run.model,
    NO_TOKENS,
    descriptor.markup,
    Number.isFinite(cost) && cost >= 0 ? cost : undefined,
  );
  return breakdown.finalCost > 0 ? breakdown : null;
}

/** A Kortix-billed answer without a price is not served for free (CWE-840): it is not delivered. */
function unpriced(run: Run): Refusal {
  run.logger.error(`[gateway] ${run.id}: ${run.descriptor?.provider} audio answered ${run.model} without a price`);
  return { status: 502, code: 'audio_model_unpriced', message: `${run.model} answered without a price.`, suggestion: 'Retry the request.' };
}

async function recordUsage(run: Run, cost: { upstreamCost: number; finalCost: number }): Promise<void> {
  const descriptor = run.descriptor!;
  const { principal } = run;
  try {
    await run.hooks.recordUsage({
      ...NO_TOKENS,
      ...identity(principal),
      provider: shownProvider(descriptor),
      model: shownModel(descriptor, run.model),
      ...(descriptor.publicProvider
        ? { upstream: { provider: descriptor.provider, model: descriptor.resolvedModel ?? run.model } }
        : {}),
      ...cost,
      billingMode: descriptor.billingMode,
      streaming: run.operation === 'speech',
      requestId: run.id,
      operation: `audio.${run.operation}`,
      ...(principal.billingHold ? { billingHoldUsd: principal.billingHold.amountUsd } : {}),
    });
  } catch (error) {
    run.logger.error(`[gateway] ${run.id}: audio usage was not recorded — ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Speech-to-text: one upstream call, billed from the answer's `usage.cost`. */
async function transcribe(run: Run, input: Extract<Input, { operation: 'transcriptions' }>): Promise<Response> {
  const descriptor = run.descriptor!;
  input.form.set('model', descriptor.resolvedModel ?? run.model);
  const headers = upstreamHeaders(descriptor, run.id);
  // fetch writes the multipart content type, with its boundary.
  delete headers['content-type'];
  let response: Response;
  try {
    response = await run.fetchImpl(`${trimTrailingSlash(descriptor.baseUrl)}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: input.form,
      signal: run.signal,
    });
  } catch (error) {
    run.logger.warn(`[gateway] ${run.id}: ${descriptor.provider} audio unreachable — ${error instanceof Error ? error.message : String(error)}`);
    return refuse(run, stopped(run) ?? unreachable(run));
  }
  run.emit.mark('upstream_response');
  if (!response.ok) return refuse(run, await upstreamRefusal(run, response));
  let answer: Record<string, unknown> | null = null;
  try {
    answer = (await response.json()) as Record<string, unknown>;
  } catch {
    // answered below
  }
  if (!answer || typeof answer !== 'object') {
    return refuse(run, stopped(run) ?? upstreamError(`${run.model} returned an unreadable answer.`));
  }
  const { usage, ...transcript } = answer as { usage?: { seconds?: unknown; cost?: unknown }; text?: unknown };
  const cost = priced(run, usage?.cost);
  if (!cost) return refuse(run, unpriced(run));
  // The client gets the billed duration; the upstream's price stays internal.
  const duration = typeof usage?.seconds === 'number' ? { usage: { type: 'duration', seconds: usage.seconds } } : {};
  const body = input.format === 'text' ? String(transcript.text ?? '') : JSON.stringify({ ...transcript, ...duration });
  await recordUsage(run, cost);
  trace(run, { status: 200, ok: true, servedModel: run.model, ...cost });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': input.format === 'text' ? 'text/plain; charset=utf-8' : 'application/json' },
  });
}

/**
 * Text-to-speech: the audio is relayed chunk by chunk as it arrives. The
 * gateway answers once the first chunk is in hand, so an upstream that fails
 * before any audio is still a typed error and not an empty 200. The upstream
 * bills from its first audio (`x-platinum-cost`), so the usage settles then,
 * off the audio's path, and the trace when the stream ends.
 */
async function speak(run: Run, input: Extract<Input, { operation: 'speech' }>): Promise<Response> {
  const descriptor = run.descriptor!;
  let response: Response;
  try {
    response = await run.fetchImpl(`${trimTrailingSlash(descriptor.baseUrl)}/audio/speech`, {
      method: 'POST',
      headers: upstreamHeaders(descriptor, run.id),
      body: JSON.stringify({ model: descriptor.resolvedModel ?? run.model, ...input.body }),
      signal: run.signal,
    });
  } catch (error) {
    run.logger.warn(`[gateway] ${run.id}: ${descriptor.provider} audio unreachable — ${error instanceof Error ? error.message : String(error)}`);
    return refuse(run, stopped(run) ?? unreachable(run));
  }
  run.emit.mark('upstream_response');
  if (!response.ok || !response.body) return refuse(run, await upstreamRefusal(run, response));
  const cost = priced(run, response.headers.get(SPEECH_COST_HEADER));
  if (!cost) {
    void response.body.cancel().catch(() => {});
    return refuse(run, unpriced(run));
  }
  const reader = response.body.getReader();
  let first: Awaited<ReturnType<typeof reader.read>>;
  try {
    do first = await reader.read();
    while (!first.done && first.value.byteLength === 0);
  } catch (error) {
    run.logger.warn(`[gateway] ${run.id}: ${descriptor.provider} speech failed before audio — ${error instanceof Error ? error.message : String(error)}`);
    return refuse(run, stopped(run) ?? upstreamError(`${run.model} stopped before any audio.`));
  }
  if (first.done) return refuse(run, upstreamError(`${run.model} returned no audio.`));
  void recordUsage(run, cost);
  let ended = false;
  const end = (fields: TraceFields) => {
    if (ended) return;
    ended = true;
    trace(run, { servedModel: run.model, ...cost, ...fields });
  };
  const chunk = first.value;
  const audio = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          end({ status: 200, ok: true });
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        const stop = stopped(run);
        end({
          status: stop?.status ?? 502,
          ok: false,
          errorCode: stop?.code ?? 'audio_stream_failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        controller.error(error);
      }
    },
    async cancel(reason) {
      end({ status: 499, ok: false, errorCode: 'client_aborted', errorMessage: 'The client cancelled the stream.' });
      await reader.cancel(reason).catch(() => {});
    },
  });
  const headers = new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' });
  const sampleRate = response.headers.get('x-sample-rate');
  if (sampleRate) headers.set('x-sample-rate', sampleRate);
  return new Response(audio, { status: 200, headers });
}

/** `POST /audio/transcriptions` and `POST /audio/speech`, OpenAI-shaped, on Kortix's managed audio models. */
export async function handleAudioRequest(runtime: HandlerRuntime, req: AudioRequest): Promise<Response> {
  const { hooks, logger } = runtime;
  const id = requestId();
  const emit = createTraceEmitter(hooks, logger, id, new Date().toISOString(), Date.now());
  const token = bearer(req.authorization);
  if (!token) {
    return errorResponse({ id, model: '' }, {
      status: 401,
      code: 'missing_token',
      message: 'Missing bearer token',
      suggestion: 'Provide a valid gateway key or account token.',
    });
  }
  const parsed = req.operation === 'transcriptions' ? await transcriptionInput(req) : speechInput(req);
  req.body = new Uint8Array(0);
  const admitted = await admit(runtime, token, parsed, { id, model: parsed.model }, emit);
  if (admitted instanceof Response) return admitted;
  const { admission, prefetched } = admitted;
  if (!admission.ok) {
    const message = admission.message ?? 'Request not allowed';
    if (admission.principal) {
      emit({
        ...identity(admission.principal),
        requestedModel: parsed.model,
        status: admission.status,
        ok: false,
        errorCode: admission.errorCode,
        errorMessage: message,
        request: null,
        response: null,
        metadata: { operation: `audio.${req.operation}` },
      });
    }
    return errorResponse({ id, model: parsed.model }, {
      status: admission.status,
      code: admission.errorCode,
      message,
      suggestion: 'Sign in again or check the account, then retry.',
    });
  }
  // The admit call already took this hold in the API: every exit below settles or refunds it.
  const hold = prefetched?.billing instanceof Error ? undefined : prefetched?.billing?.holdUsd;
  const timeout = AbortSignal.timeout(req.timeoutMs ?? AUDIO_TIMEOUT_MS);
  const run: Run = {
    hooks,
    logger,
    fetchImpl: runtime.fetchImpl ?? upstreamFetch,
    id,
    emit,
    operation: req.operation,
    principal: hold ? { ...admission.principal, billingHold: { amountUsd: hold } } : admission.principal,
    model: parsed.model,
    clientSignal: req.signal,
    signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
  };
  emit.mark('admitted');
  if ('error' in parsed) {
    return refuse(run, { status: 400, code: 'invalid_request', message: parsed.error, suggestion: 'Fix the request body and retry.' });
  }
  const resolved = await resolve(run, prefetched);
  if (!('baseUrl' in resolved)) return refuse(run, resolved);
  run.descriptor = resolved;
  const denied = await charge(run, prefetched);
  if (denied) return refuse(run, denied);
  emit.mark('dispatch');
  return parsed.input.operation === 'transcriptions' ? transcribe(run, parsed.input) : speak(run, parsed.input);
}

/** `GET /audio/voices?model=`: the voices a speech model takes. Not billed, not traced, like the model list. */
export async function handleVoicesRequest(runtime: HandlerRuntime, req: VoicesRequest): Promise<Response> {
  const { hooks, logger } = runtime;
  const id = requestId();
  const at: Named = { id, model: req.model };
  const token = bearer(req.authorization);
  if (!token) {
    return errorResponse(at, { status: 401, code: 'missing_token', message: 'Missing bearer token', suggestion: 'Provide a valid gateway key or account token.' });
  }
  let principal: AuthedPrincipal | null;
  try {
    principal = await hooks.authenticate(token);
  } catch (error) {
    logger.error(`[gateway] ${id}: admission control unavailable — ${error instanceof Error ? error.message : String(error)}`);
    return errorResponse(at, { status: 503, code: 'admission_unavailable', message: 'Gateway admission control is unavailable', suggestion: 'Retry the request.', retryAfter: 5 });
  }
  if (!principal) {
    return errorResponse(at, { status: 401, code: 'invalid_token', message: 'Invalid token', suggestion: 'Sign in again or provide a valid API token, then retry.' });
  }
  if (!req.model) {
    return errorResponse(at, { status: 400, code: 'invalid_request', message: '`model` is required: the speech model whose voices to list.', suggestion: 'Add `?model=` and retry.' });
  }
  const timeout = AbortSignal.timeout(AUDIO_TIMEOUT_MS);
  const run: Run = {
    hooks,
    logger,
    fetchImpl: runtime.fetchImpl ?? upstreamFetch,
    id,
    emit: createTraceEmitter(hooks, logger, id, new Date().toISOString(), Date.now()),
    operation: 'speech',
    principal,
    model: req.model,
    clientSignal: req.signal,
    signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
  };
  const resolved = await resolve(run, null);
  if (!('baseUrl' in resolved)) return errorResponse(run, resolved);
  run.descriptor = resolved;
  const headers = upstreamHeaders(resolved, id);
  delete headers['content-type'];
  let response: Response;
  try {
    response = await run.fetchImpl(`${trimTrailingSlash(resolved.baseUrl)}/audio/voices`, { method: 'GET', headers, signal: run.signal });
  } catch (error) {
    logger.warn(`[gateway] ${id}: ${resolved.provider} voices unreachable — ${error instanceof Error ? error.message : String(error)}`);
    return errorResponse(run, stopped(run) ?? unreachable(run));
  }
  if (!response.ok) return errorResponse(run, await upstreamRefusal(run, response));
  const answer = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (!Array.isArray(answer?.data)) return errorResponse(run, upstreamError(`${run.model} returned an unreadable voice list.`));
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  // Only the documented fields reach the client.
  const data = (answer.data as Record<string, unknown>[])
    .filter((voice) => typeof voice?.id === 'string')
    .map((voice) => ({
      id: voice.id,
      name: typeof voice.name === 'string' ? voice.name : voice.id,
      description: typeof voice.description === 'string' ? voice.description : '',
      languages: strings(voice.languages),
      tags: strings(voice.tags),
    }));
  return new Response(JSON.stringify({ object: 'list', data }), { status: 200, headers: { 'content-type': 'application/json' } });
}
