/**
 * WS3-P1-b — pin-work for the durable ACP envelope persistence laws.
 *
 * This file covers the two pins that are pure SDK-projection consumption and
 * need no DB mock at all:
 *
 *   4. Lossless JSONL round-trip — `AcpStoredEnvelope[]` rows through
 *      `acpTranscriptJsonl` (`@kortix/sdk/acp/transcript`, consumed
 *      read-only — never modified here) and back, over a realistic mixed
 *      fixture shaped like `packages/sdk/src/acp/__fixtures__/acp-session-
 *      mixed.json` (prompt / tool_call / tool_call_update / permission /
 *      question).
 *   5. Raw means raw (SDK-export half) — an envelope with unusual-but-valid
 *      extra vendor keys survives `acpTranscriptJsonl` byte-identically.
 *      The persist-path half of pin 5 (does the app's `db.insert(...)
 *      .values()` call receive that same envelope unmodified?) is pinned in
 *      the sibling `../routes/acp.envelope-persistence.test.ts`, which needs
 *      the route/db mock harness this file doesn't.
 *
 * `acpTranscriptJsonl` was previously imported but never actually exercised
 * by `packages/sdk/src/acp/transcript.test.ts` (grep-verified: the import
 * appears once, in the import list, with zero call sites) — this file is the
 * first place in the repo that pins its round-trip behavior.
 */
import { describe, expect, test } from 'bun:test';
import { acpTranscriptJsonl, type AcpStoredEnvelope } from '@kortix/sdk/acp/transcript';

/**
 * A realistic mixed transcript, shaped like the mixed rows in
 * `packages/sdk/src/acp/__fixtures__/acp-session-mixed.json` (client prompt,
 * agent tool_call + tool_call_update, agent permission request, agent
 * question/request_input) — reproduced inline rather than imported across
 * the package boundary, matching this repo's existing convention of
 * building representative `AcpStoredEnvelope[]` literals per test file
 * (see `packages/sdk/src/acp/transcript.test.ts`'s own row builders) rather
 * than reaching into another package's `src/`.
 */
function mixedRows(): AcpTranscriptRowFull[] {
  return [
    {
      ordinal: 1,
      direction: 'client_to_agent',
      streamEventId: null,
      createdAt: '2026-07-15T00:00:00.000Z',
      envelope: {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/prompt',
        params: {
          prompt: [
            { type: 'text', text: 'Look at this file and image' },
            { type: 'resource_link', uri: 'https://example.com/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' },
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          ],
        },
      },
    },
    {
      ordinal: 6,
      direction: 'agent_to_client',
      streamEventId: 5,
      createdAt: '2026-07-15T00:00:01.000Z',
      envelope: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'Read file',
            kind: 'read',
            status: 'pending',
            rawInput: { path: 'a.pdf' },
          },
        },
      },
    },
    {
      ordinal: 7,
      direction: 'agent_to_client',
      streamEventId: 6,
      createdAt: '2026-07-15T00:00:02.000Z',
      envelope: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: { bytes: 128 } },
        },
      },
    },
    {
      ordinal: 13,
      direction: 'agent_to_client',
      streamEventId: 12,
      createdAt: '2026-07-15T00:00:03.000Z',
      envelope: {
        jsonrpc: '2.0',
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          permission: 'bash',
          patterns: ['rm -rf *'],
          options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }],
          toolCall: { title: 'Shell' },
        },
      },
    },
    {
      ordinal: 39,
      direction: 'agent_to_client',
      streamEventId: 38,
      createdAt: '2026-07-15T00:00:04.000Z',
      envelope: {
        jsonrpc: '2.0',
        id: 11,
        method: 'session/request_input',
        params: {
          questions: [
            { key: 'confirm', question: 'Proceed?', options: [{ optionId: 'yes', label: 'Yes' }, { optionId: 'no', label: 'No' }] },
          ],
        },
      },
    },
  ];
}

/** The fully-resolved stored-row shape every real persisted row has — no
 *  optional fields (mirrors the SDK's own `AcpTranscriptRow` type), so
 *  `JSON.stringify` never silently drops a key on the way out. */
type AcpTranscriptRowFull = {
  ordinal: number;
  direction: 'client_to_agent' | 'agent_to_client';
  streamEventId: number | null;
  createdAt: string;
  envelope: AcpStoredEnvelope['envelope'];
};

function parseJsonl(jsonl: string): unknown[] {
  return jsonl.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

describe('Pin 4 — lossless JSONL round-trip (acpTranscriptJsonl, consumed read-only)', () => {
  test('every row round-trips byte-identically: parsed-back envelope deep-equals the persisted envelope, for every kind in the mixed fixture (prompt, tool_call, tool_call_update, permission, question)', () => {
    const rows = mixedRows();
    const jsonl = acpTranscriptJsonl(rows);
    const parsed = parseJsonl(jsonl);
    expect(parsed).toHaveLength(rows.length);
    parsed.forEach((line, i) => {
      expect((line as { envelope: unknown }).envelope).toEqual(rows[i]!.envelope);
    });
  });

  test('"lossless" concretely means: the parsed-back line equals the FULL stored row — {ordinal, direction, streamEventId, createdAt, envelope} — no more, no fewer keys, no wrapper', () => {
    const rows = mixedRows();
    const jsonl = acpTranscriptJsonl(rows);
    const parsed = parseJsonl(jsonl) as Array<Record<string, unknown>>;
    parsed.forEach((line, i) => {
      expect(Object.keys(line).sort()).toEqual(['createdAt', 'direction', 'envelope', 'ordinal', 'streamEventId'].sort());
      expect(line).toEqual({
        ordinal: rows[i]!.ordinal,
        direction: rows[i]!.direction,
        streamEventId: rows[i]!.streamEventId,
        createdAt: rows[i]!.createdAt,
        envelope: rows[i]!.envelope,
      });
    });
  });

  test('row ORDER is preserved through the export — one line per row, same sequence, never reordered', () => {
    const rows = mixedRows();
    const jsonl = acpTranscriptJsonl(rows);
    const parsed = parseJsonl(jsonl) as Array<{ ordinal: number }>;
    expect(parsed.map((r) => r.ordinal)).toEqual(rows.map((r) => r.ordinal));
  });

  test('a null streamEventId round-trips as explicit null, not as a dropped/absent key (JSON.stringify would silently drop an `undefined` key here — this pins that the row always supplies a concrete null instead)', () => {
    const rows = [mixedRows()[0]!]; // the prompt row: streamEventId === null
    const parsed = parseJsonl(acpTranscriptJsonl(rows)) as Array<Record<string, unknown>>;
    expect('streamEventId' in parsed[0]!).toBe(true);
    expect(parsed[0]!.streamEventId).toBeNull();
  });

  test('empty input produces an empty string (no trailing newline, no wrapper array)', () => {
    expect(acpTranscriptJsonl([])).toBe('');
  });

  test('non-empty input ends with exactly one trailing newline', () => {
    const jsonl = acpTranscriptJsonl([mixedRows()[0]!]);
    expect(jsonl.endsWith('\n')).toBe(true);
    expect(jsonl.endsWith('\n\n')).toBe(false);
  });
});

describe('Pin 5 — raw means raw (SDK-export half)', () => {
  test('an envelope with unusual-but-valid extra vendor keys (nested, array-valued, non-ASCII) survives acpTranscriptJsonl byte-identically', () => {
    const weird: AcpTranscriptRowFull = {
      ordinal: 100,
      direction: 'agent_to_client',
      streamEventId: 99,
      createdAt: '2026-07-15T00:00:05.000Z',
      envelope: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
        // Extra vendor keys a harness might attach — the persist path must
        // not strip, rewrite, or normalize any of these away.
        _vendor: { harness: 'custom-cli', trace: [1, 2, 3], flags: { beta: true, ratio: 0.5 } },
        'x-unicode-key-é中': 'é中😀', // é中😀
        nullField: null,
        emptyArray: [],
      },
    };

    const parsed = parseJsonl(acpTranscriptJsonl([weird])) as Array<{ envelope: unknown }>;
    expect(parsed[0]!.envelope).toEqual(weird.envelope);
    // Byte-identical, not just deep-equal: re-serializing the round-tripped
    // envelope with the same JSON.stringify the export itself uses produces
    // the exact same bytes as re-serializing the original.
    expect(JSON.stringify(parsed[0]!.envelope)).toBe(JSON.stringify(weird.envelope));
  });
});
