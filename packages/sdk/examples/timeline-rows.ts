/**
 * Timeline rows — flatten a transcript into a virtualizer-ready row list, then
 * reuse row identities across frames.
 *
 * `constructTimelineRows` turns raw messages into ONE flat, ordered, uniquely
 * keyed list. `reuseTimelineRows` diffs the new list against the previous one
 * and hands back the PREVIOUS object for every row that did not change — and
 * the previous ARRAY when no row changed at all. That is what lets a list
 * renderer skip subtrees while the last turn streams.
 *
 * Rows hold ids, never part content, which is what makes the reuse safe: a
 * text part whose body grows keeps its `(messageID, partID)`, so its row is
 * unchanged and the consumer reads the live body from the store by ref.
 *
 * Both functions are pure and framework-free — no React, no DOM, no Node.
 *
 * Run:
 *   bun run examples/timeline-rows.ts
 *
 * As an npm consumer:
 *   import {
 *     constructTimelineRows,
 *     reuseTimelineRows,
 *     type TimelineRow,
 *   } from '@kortix/sdk/turns';
 */
import {
  constructTimelineRows,
  reuseTimelineRows,
  type TimelineMessageLike,
  type TimelineRow,
} from '../src/core/turns/index';

interface Message extends TimelineMessageLike {
  info: { id: string; role: string; parentID?: string; error?: unknown };
  parts: Array<{ type: string; id: string; text?: string }>;
}

const frameOne: Message[] = [
  {
    info: { id: 'msg_000000000001', role: 'user' },
    parts: [{ type: 'text', id: 'prt_a', text: 'what files are here?' }],
  },
  {
    info: { id: 'msg_000000000002', role: 'assistant', parentID: 'msg_000000000001' },
    parts: [{ type: 'text', id: 'prt_b', text: 'Let me look' }],
  },
];

// The next SSE frame: the same text part, longer, plus one brand-new part.
const frameTwo: Message[] = [
  frameOne[0],
  {
    info: frameOne[1].info,
    parts: [
      { type: 'text', id: 'prt_b', text: 'Let me look at the repository root.' },
      { type: 'text', id: 'prt_c', text: 'Found 12 files.' },
    ],
  },
];

function describe(row: TimelineRow): string {
  switch (row.kind) {
    case 'assistant-part':
      return row.group.type === 'part'
        ? `assistant-part ${row.group.ref.partID}`
        : `assistant-part context(${row.group.refs.length})`;
    case 'turn-divider':
      return `turn-divider ${row.label}`;
    case 'diff-summary':
      return `diff-summary ${row.diffs.length} file(s)`;
    case 'error':
      return `error ${row.text}`;
    default:
      return row.kind;
  }
}

const first = constructTimelineRows(frameOne);
console.log('frame 1:', first.map(describe));

const rebuilt = constructTimelineRows(frameTwo);
const second = reuseTimelineRows(first, rebuilt);
console.log('frame 2:', second.map(describe));

// Every row that already existed comes back by identity; only the new part row
// is a new object. `prt_b`'s body grew, but its row is unchanged.
const reused = first.filter((row, index) => second[index] === row).length;
console.log(`reused ${reused} of ${first.length} prior rows`);
console.log('new rows:', second.length - reused);

// An unchanged frame returns the previous ARRAY itself, so a `useMemo` over
// `rows` never fires.
const unchanged = reuseTimelineRows(second, constructTimelineRows(frameTwo));
console.log('array identity preserved on an unchanged frame:', unchanged === second);
