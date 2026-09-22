import { describe, expect, test } from 'bun:test';
import { chooseOlderSource, mirrorCursorAfter } from './mirror-paging';

describe('which source answers "older"', () => {
	test('the runtime wins whenever it can answer', () => {
		// A live read outranks a snapshot, always — the same rule
		// `shouldHydrateFromMirror` enforces on the way in.
		expect(chooseOlderSource({ runtimeHasOlder: true, mirrorCursor: 'msg_5' })).toBe('runtime');
	});

	test('the mirror answers while the runtime cannot', () => {
		// The sandbox is stopped or still starting: the controller has no cursor
		// because its page reads throw RuntimeNotReadyError, and without this the
		// saved history is stuck at whatever the first window held.
		expect(chooseOlderSource({ runtimeHasOlder: false, mirrorCursor: 'msg_5' })).toBe('mirror');
	});

	test('nobody answers when neither has a page', () => {
		expect(chooseOlderSource({ runtimeHasOlder: false, mirrorCursor: null })).toBeNull();
		expect(chooseOlderSource({ runtimeHasOlder: false, mirrorCursor: undefined })).toBeNull();
	});
});

describe('the cursor a mirror window leaves behind', () => {
	test('a window that reports one is the cursor for the next request', () => {
		expect(mirrorCursorAfter({ next_cursor: 'msg_older' })).toBe('msg_older');
	});

	test('a window that reaches the oldest row ends the walk', () => {
		expect(mirrorCursorAfter({ next_cursor: null })).toBeNull();
	});

	test('an older API sends no cursor at all, which also ends the walk', () => {
		// `next_cursor` is optional precisely because a self-host or staging
		// backend behind this client answers without it. Absent must read as
		// "no more", never as "ask again with undefined".
		expect(mirrorCursorAfter({})).toBeNull();
		expect(mirrorCursorAfter(null)).toBeNull();
		expect(mirrorCursorAfter(undefined)).toBeNull();
	});
});
