import { expect, test } from 'bun:test';
import { jumpToOutcome } from './jump-to-outcome';

test('an already loaded response jumps even if older pages cannot load', async () => {
  const calls: string[] = [];
  await jumpToOutcome({ needsHistory: false,
    history: { readState: () => ({ hasOlder: true, isLoadingOlder: false }), loadOlder: () => { throw Error('offline'); }, settle: async () => {} },
    resolve: () => 'recent', scroll: async (key) => { calls.push(key); return true; },
    unavailable: () => calls.push('unavailable'), loadError: () => calls.push('error'),
  });
  expect(calls).toEqual(['recent']);
});
test('older history loads before resolving its updated anchor', async () => {
  let older = true;
  let anchor = 'wrong-first-loaded-turn';
  const calls: string[] = [];
  await jumpToOutcome({ needsHistory: true,
    history: { readState: () => ({ hasOlder: older, isLoadingOlder: false }), loadOlder: () => { older = false; anchor = 'producing-response'; }, settle: async () => {} },
    resolve: () => anchor, scroll: async (key) => { calls.push(key); return true; },
    unavailable: () => calls.push('unavailable'), loadError: () => calls.push('error'),
  });
  expect(calls).toEqual(['producing-response']);
});
test('failed history loading reports why rather than jumping to a false anchor', async () => {
  const calls: string[] = [];
  await jumpToOutcome({ needsHistory: true,
    history: { readState: () => ({ hasOlder: true, isLoadingOlder: false }), loadOlder: () => { throw Error('offline'); }, settle: async () => {} },
    resolve: () => 'wrong', scroll: async (key) => { calls.push(key); return true; },
    unavailable: () => calls.push('unavailable'), loadError: () => calls.push('error'),
  });
  expect(calls).toEqual(['error']);
});
test('a missing DOM destination reports unavailable', async () => {
  const calls: string[] = [];
  await jumpToOutcome({ needsHistory: false,
    history: { readState: () => ({ hasOlder: false, isLoadingOlder: false }), loadOlder: () => {}, settle: async () => {} },
    resolve: () => 'removed', scroll: async () => false,
    unavailable: () => calls.push('unavailable'), loadError: () => calls.push('error'),
  });
  expect(calls).toEqual(['unavailable']);
});
