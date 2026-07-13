import { test, expect } from 'bun:test';
import {
	buildAuthHeaders,
	isStreamingRequest,
	normalizeAuthenticatedUrl,
	syntheticUnauthenticatedResponse,
	withDefaultTimeout,
	withTokenRetry,
} from '../../platform/auth-core';

// These tests deliberately target `auth-core.ts` — the pure implementation —
// NOT `./auth`. Several suites in this package register process-wide
// `mock.module('./auth', …)` stubs, and Bun's `mock.module`
// replaces the specifier for every importer for the remainder of the test
// process, in whatever order the runner picks (which differs across Bun
// versions — this bit us on CI while passing locally). `auth.ts` is a thin
// delegating shell over these functions; nothing mocks `auth-core`, so the
// semantics pinned here are always the real ones.

// ── withTokenRetry — actually retries now (previously accepted attempts/
// baseDelayMs/invalidateBetweenAttempts and silently ignored all three) ──────

function sequenceGetter(sequence: Array<string | null>) {
	let calls = 0;
	const getToken = async () => {
		const t = sequence[Math.min(calls, sequence.length - 1)] ?? null;
		calls += 1;
		return t;
	};
	return { getToken, callCount: () => calls };
}

test('retries until getToken() returns a truthy token, up to `attempts`', async () => {
	const { getToken, callCount } = sequenceGetter([null, null, 'tok-3']);
	const token = await withTokenRetry(getToken, { attempts: 3, baseDelayMs: 0 });
	expect(token).toBe('tok-3');
	expect(callCount()).toBe(3);
});

test('gives up after `attempts` and returns the last (falsy) result — never retries forever', async () => {
	const { getToken, callCount } = sequenceGetter([null, null, null, null]);
	const token = await withTokenRetry(getToken, { attempts: 2, baseDelayMs: 0 });
	expect(token).toBeNull();
	expect(callCount()).toBe(2);
});

test('defaults to a single attempt (no retry) when options are omitted', async () => {
	const { getToken, callCount } = sequenceGetter([null, 'tok']);
	const token = await withTokenRetry(getToken);
	expect(token).toBeNull();
	expect(callCount()).toBe(1);
});

test('invalidateBetweenAttempts fires the invalidation hook before each RETRY (not the first attempt)', async () => {
	let invalidations = 0;
	const { getToken } = sequenceGetter([null, null, 'tok']);
	const token = await withTokenRetry(
		getToken,
		{ attempts: 3, baseDelayMs: 0, invalidateBetweenAttempts: true },
		() => {
			invalidations += 1;
		},
	);
	expect(token).toBe('tok');
	expect(invalidations).toBe(2);
});

// ── withDefaultTimeout — default 30s timeout, EXCEPT for the SSE event stream
// endpoint, composed with any caller-supplied signal ─────────────────────────

test('applies a default (non-aborted) timeout signal to a non-streaming request', () => {
	const signal = withDefaultTimeout('http://sbx.test/kortix/health', undefined);
	expect(signal).toBeDefined();
	expect(signal?.aborted).toBe(false);
});

test('the removed OpenCode /global/event route is not treated as a canonical stream', () => {
	expect(isStreamingRequest('http://sbx.test/global/event')).toBe(false);
	expect(withDefaultTimeout('http://sbx.test/global/event', undefined)).toBeDefined();
});

test('does NOT impose a default timeout on a session-scoped ACP request', () => {
	const url = 'http://api.test/v1/projects/p/sessions/s/acp';
	expect(isStreamingRequest(url)).toBe(true);
	expect(withDefaultTimeout(url, { method: 'POST' })).toBeUndefined();
});

test('does NOT impose a default timeout on a direct ACP daemon request', () => {
	const url = 'http://sandbox.test/acp/runtime-id?agent=codex';
	expect(isStreamingRequest(url)).toBe(true);
	expect(withDefaultTimeout(url, { method: 'POST' })).toBeUndefined();
});

test('composes a caller-supplied signal with the default timeout on a non-streaming request', () => {
	const controller = new AbortController();
	controller.abort();
	const signal = withDefaultTimeout('http://sbx.test/kortix/health', {
		signal: controller.signal,
	});
	// The already-aborted caller signal propagates through AbortSignal.any.
	expect(signal?.aborted).toBe(true);
});

test('preserves the caller-supplied signal as-is on the ACP streaming endpoint', () => {
	const controller = new AbortController();
	const signal = withDefaultTimeout('http://sbx.test/acp/runtime-id?agent=codex', {
		signal: controller.signal,
	});
	expect(signal).toBe(controller.signal);
});

test('a Request input carries its own signal through the streaming exemption', () => {
	const controller = new AbortController();
	const req = new Request('http://sbx.test/acp/runtime-id?agent=codex', { signal: controller.signal });
	const signal = withDefaultTimeout(req, undefined);
	// A Request always carries a signal (the caller's, here) — it must pass
	// through untouched on the exempted path.
	expect(signal?.aborted).toBe(false);
	controller.abort();
	expect(signal?.aborted).toBe(true);
});

// ── buildAuthHeaders / syntheticUnauthenticatedResponse ─────────────────────

test('buildAuthHeaders injects the Bearer token without clobbering an existing Authorization', () => {
	const injected = buildAuthHeaders('http://x.test/', undefined, 'tok');
	expect(injected.get('Authorization')).toBe('Bearer tok');

	const preset = buildAuthHeaders(
		'http://x.test/',
		{ headers: { Authorization: 'Bearer mine' } },
		'tok',
	);
	expect(preset.get('Authorization')).toBe('Bearer mine');
});

test('the synthetic 401 is a JSON fetch-semantics Response (no network call implied)', async () => {
	const res = syntheticUnauthenticatedResponse();
	expect(res.status).toBe(401);
	expect(await res.json()).toEqual({ error: 'Not authenticated' });
});

test('authenticated request URLs are canonicalized and reject unsafe URL forms', () => {
	expect(
		normalizeAuthenticatedUrl(
			'https://api.kortix.test/v1/projects/p/sessions/s/acp',
			'https://api.kortix.test/v1',
		),
	).toBe('https://api.kortix.test/v1/projects/p/sessions/s/acp');
	expect(
		normalizeAuthenticatedUrl('https://runtime.kortix.test/acp', 'https://api.kortix.test/v1'),
	).toBe('https://runtime.kortix.test/acp');
	expect(() =>
		normalizeAuthenticatedUrl('https://user:pass@api.kortix.test/v1', 'https://api.kortix.test/v1'),
	).toThrow('cannot contain credentials');
	expect(() =>
		normalizeAuthenticatedUrl('file:///tmp/token', 'https://api.kortix.test/v1'),
	).toThrow('must use http or https');
});
