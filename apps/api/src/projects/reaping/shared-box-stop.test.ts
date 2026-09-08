// THE REAPER MUST NOT POWER OFF SOMEBODY ELSE'S SESSION.
//
// A shared cell host carries many sessions in one sandbox. The reaper reaps ONE
// session and then stops its box, which for a shared host is a session nobody
// asked to end. That is the whole reason KORTIX_CELL_SHARED_HOST_ENABLED is off
// by default, and it costs every session ~1074 ms of its own microVM: measured
// on dev, a session on an existing cell sandbox is 194 ms cold against 2443 ms
// for one that boots its own.
import { describe, expect, test } from 'bun:test';
import { decideSharedBoxStop } from './shared-box-stop';

describe('reaping a session whose box may be shared', () => {
  test('stops the box when this session is the only one on it — the ordinary case', () => {
    // Two sessions never share an external id unless a shared host put them
    // there, so this is every box in a deployment with the flag off.
    expect(decideSharedBoxStop(0)).toBe('stop_the_box');
  });

  test('leaves the box running when another live session is on it', () => {
    expect(decideSharedBoxStop(1)).toBe('release_this_session_only');
    expect(decideSharedBoxStop(7)).toBe('release_this_session_only');
  });

  test('an unreadable count stops the box, because the alternative strands it forever', () => {
    // Failing the other way would keep a box alive on a number nobody could
    // read — a leak with no owner and no deadline. The reaper's own claim
    // already guarantees this session is finished.
    expect(decideSharedBoxStop(Number.NaN)).toBe('stop_the_box');
    expect(decideSharedBoxStop(-1)).toBe('stop_the_box');
  });
});
