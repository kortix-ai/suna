import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../core/http/config';
import { loadOlderSessionTranscriptMirror } from './server-transcript-mirror';

let calls: string[] = [];
let next: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
	calls = [];
	next = { status: 200, body: {} };
	globalThis.fetch = mock(async (url: unknown) => {
		calls.push(String(url));
		return new Response(JSON.stringify(next.body), {
			status: next.status,
			headers: { 'content-type': 'application/json' },
		});
	}) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

const envelope = (over: Record<string, unknown> = {}) => ({
	available: true,
	reason: null,
	source: 'mirror',
	complete: false,
	captured_at: '2026-09-22T00:00:00.000Z',
	opencode_session_id: 'ses_root',
	message_count: 1,
	total: 242,
	next_cursor: 'msg_older',
	messages: [],
	...over,
});

test('the older window is requested with the cursor the previous window left', async () => {
	next = { status: 200, body: envelope() };
	const result = await loadOlderSessionTranscriptMirror({
		kortixSessionScope: 'p1/s1',
		before: 'msg_tail',
	});
	expect(calls).toHaveLength(1);
	expect(calls[0]).toContain('/projects/p1/sessions/s1/transcript');
	expect(calls[0]).toContain('before=msg_tail');
	expect(result?.next_cursor).toBe('msg_older');
});

test('it does not send history=true, which would 403 a pre-flag mirror', async () => {
	// `history=true` gates on `session_transcript_history`. Sessions captured
	// before the flag existed still have rows; paging them must not require it.
	next = { status: 200, body: envelope() };
	await loadOlderSessionTranscriptMirror({ kortixSessionScope: 'p1/s1', before: 'msg_tail' });
	expect(calls[0]).not.toContain('history=');
});

test('a failed read answers null instead of throwing into the transcript', async () => {
	next = { status: 500, body: { error: 'boom' } };
	expect(
		await loadOlderSessionTranscriptMirror({ kortixSessionScope: 'p1/s1', before: 'msg_tail' }),
	).toBeNull();
});

test('no scope means no request at all', async () => {
	expect(
		await loadOlderSessionTranscriptMirror({ kortixSessionScope: undefined, before: 'msg_tail' }),
	).toBeNull();
	expect(calls).toHaveLength(0);
});
