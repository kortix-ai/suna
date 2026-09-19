import { describe, expect, test } from 'bun:test';
import { resolveSelectedRuntimeSession } from './selected-runtime-session';

const child = { id: 'ses_child' };
const root = { id: 'ses_root' };

describe('resolveSelectedRuntimeSession — the ?oc= sub-session a sidebar link names', () => {
  test('no ?oc: nothing selected, nothing to drop', () => {
    expect(
      resolveSelectedRuntimeSession({
        selectedId: null,
        listed: [root],
        listLoading: false,
        lookup: { data: undefined, settled: false },
      }),
    ).toEqual({ session: null, drop: false });
  });

  test('a child the cached list already has is selected at once', () => {
    expect(
      resolveSelectedRuntimeSession({
        selectedId: 'ses_child',
        listed: [root, child],
        listLoading: false,
        lookup: { data: undefined, settled: false },
      }),
    ).toEqual({ session: child, drop: false });
  });

  test('a child the cached list does NOT have yet is not dropped while it is looked up', () => {
    // The sidebar learns of sub-sessions from the Kortix session row; the page's
    // runtime list is a 5-minute cache. A fresh child is absent from it, and
    // dropping ?oc here is what left the click on the parent.
    expect(
      resolveSelectedRuntimeSession({
        selectedId: 'ses_child',
        listed: [root],
        listLoading: false,
        lookup: { data: undefined, settled: false },
      }),
    ).toEqual({ session: null, drop: false });
  });

  test('the lookup by id finds it: selected, even though the list never had it', () => {
    expect(
      resolveSelectedRuntimeSession({
        selectedId: 'ses_child',
        listed: [root],
        listLoading: false,
        lookup: { data: child, settled: true },
      }),
    ).toEqual({ session: child, drop: false });
  });

  test('the lookup settles with nothing: only then is ?oc dropped', () => {
    expect(
      resolveSelectedRuntimeSession({
        selectedId: 'ses_gone',
        listed: [root],
        listLoading: false,
        lookup: { data: undefined, settled: true },
      }),
    ).toEqual({ session: null, drop: true });
  });

  test('a list still loading drops nothing', () => {
    expect(
      resolveSelectedRuntimeSession({
        selectedId: 'ses_gone',
        listed: [],
        listLoading: true,
        lookup: { data: undefined, settled: true },
      }),
    ).toEqual({ session: null, drop: false });
  });
});
