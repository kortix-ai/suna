// THE PART OF A SESSION CREATE THE USER ACTUALLY WAITS FOR.
//
// `[provision-timeline] session-create` lives inside a fire-and-forget
// `void (async () => …)()`, so it reports BACKGROUND provisioning — 60-105 ms,
// every time, whatever the request cost. Reading that number and concluding
// create was fast is a mistake the instrument made easy, and I made it: the
// request was 666-773 ms on the same creates that printed 93 ms.
//
// With the request measured in its own right, in-region 2026-09-09:
//
//   total=748ms {"agents":686,"connectors":7,"caps+billing":31,"insert":24}
//   total= 44ms {"agents": 11,"connectors":1,"caps+billing":18,"insert":14}
//   total=616ms {"agents":566,"connectors":4,"caps+billing":29,"insert":17}
//
// `loadProjectAgents` is 566-686 ms cold and 11 ms warm. That is the whole
// cold cost of a session create, in one call, behind a cache that expires —
// and it is what a user pays on their first action after a pause. It is NOT
// auth: a cheap authenticated GET on the same process is 76-131 ms and does
// not change after 25 s idle.
//
// These claims read the source. A timing line that drifts back inside the
// fire-and-forget block would report the wrong thing again, silently, and no
// behavioural test would notice.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./sessions.ts', import.meta.url), 'utf8');

describe('the session-create request timeline', () => {
  test('starts before any of the work, not inside the background kick', () => {
    const reqStart = SRC.indexOf('const reqT0 = Date.now()');
    const kick = SRC.indexOf("new ProvisionTimeline(sessionId, 'session-create')");
    expect(reqStart).toBeGreaterThan(-1);
    expect(kick).toBeGreaterThan(-1);
    // The request clock has to be earlier in the function than the background
    // timeline it was confused with.
    expect(reqStart).toBeLessThan(kick);
  });

  test('names the four boundaries, so a total is never reported alone', () => {
    for (const part of ['agents', 'connectors', 'caps+billing', 'insert']) {
      expect(SRC).toContain(`reqMark('${part}')`);
    }
  });

  test('marks the agent load, which is the whole cold cost', () => {
    // The CALL SITE, not the import — both names appear at the top of the file.
    const load = SRC.indexOf('await loadProjectAgents(');
    const mark = SRC.indexOf("reqMark('agents')");
    expect(load).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(load);
    // The mark has to land BEFORE the next unit of work starts, or that work's
    // time is attributed to the agent load. The first version of this claim
    // only checked that nothing else was marked in between, and passed under a
    // mutant that moved the mark past the connector validation entirely.
    const nextWork = SRC.indexOf('await validateSessionConnectorBindings(');
    expect(nextWork).toBeGreaterThan(load);
    expect(mark).toBeLessThan(nextWork);
    expect(SRC.slice(load, mark)).not.toContain('reqMark(');
  });

  test('logs the parts and the total together', () => {
    // Anchor on the LOG STATEMENT, not the name: the name also appears in the
    // comment that records the measurement, and matching that made this claim
    // fail for a reason that had nothing to do with the code.
    const stmt = SRC.indexOf('`[session-create:request] session=');
    expect(stmt).toBeGreaterThan(-1);
    expect(SRC.slice(stmt, stmt + 200)).toContain('JSON.stringify(reqLap)');
  });

  test('the background timeline is still fire-and-forget — this did not make it blocking', () => {
    const kick = SRC.lastIndexOf('void (async () => {');
    const tl = SRC.indexOf("new ProvisionTimeline(sessionId, 'session-create')");
    expect(kick).toBeGreaterThan(-1);
    expect(tl).toBeGreaterThan(kick);
  });
});
