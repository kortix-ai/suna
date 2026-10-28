import { describe, expect, test } from 'bun:test';

import { AUTOSAVE_MS, SAVE_GAP_MS, VERIFY_MS, createDocSaver, pendingSave, type DocSaveStatus, type Timers } from './doc-autosave';

/** A fake clock: timers run only when the test moves time. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const timers: Timers = {
    now: () => now,
    set: (fn, ms) => {
      due.set(++seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clear: (id) => void due.delete(id as number),
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    await settle();
    for (;;) {
      const nextTimer = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!nextTimer) break;
      due.delete(nextTimer[0]);
      now = nextTimer[1].at;
      nextTimer[1].fn();
      await settle();
      await settle();
    }
    now = end;
    await settle();
  };
  return { timers, advance, now: () => now };
}

class Conflict extends Error {}

/**
 * The entry in Files: a version per write, If-Match on `base`. `latency`
 * holds each write open for that long on the fake clock.
 */
function fakeFile(text: string, clock: ReturnType<typeof fakeTimers>) {
  let version = 1;
  const file = {
    text,
    version: () => `v${version}`,
    writes: [] as Array<{ text: string; base: string | null; startedAt: number }>,
    latency: 0,
    /** Another writer, or the mount's merge: a new version, any text. */
    replace(next: string) {
      file.text = next;
      version += 1;
    },
    async write(next: string, base: string | null) {
      file.writes.push({ text: next, base, startedAt: clock.now() });
      if (file.latency) await new Promise<void>((resolve) => clock.timers.set(resolve, file.latency));
      if (base && base !== `v${version}`) throw new Conflict('version_conflict');
      file.replace(next);
      return `v${version}`;
    },
  };
  return file;
}

let docs = 0;
function setup(start = 'start') {
  const clock = fakeTimers();
  const file = fakeFile(start, clock);
  const statuses: DocSaveStatus[] = [];
  let conflicts = 0;
  let editor = start;
  const artifactId = `doc-${++docs}`;
  const saver = createDocSaver({ version: file.version(), text: start }, {
    artifactId,
    write: (text, base) => file.write(text, base),
    read: async () => ({ version: file.version(), text: file.text }),
    text: () => editor,
    onStatus: (s) => statuses.push(s),
    onConflict: () => void (conflicts += 1),
    isConflict: (err) => err instanceof Conflict,
    timers: clock.timers,
  });
  const type = (text: string) => {
    editor = text;
    saver.edited();
  };
  return { clock, file, saver, statuses, type, artifactId, conflicts: () => conflicts };
}

describe('doc autosave', () => {
  test('edits during a slow save wait for it and go out as one follow-up save on the new version', async () => {
    const { clock, file, type, statuses } = setup();
    file.latency = 3_000;
    type('a');
    await clock.advance(AUTOSAVE_MS);
    type('ab');
    await clock.advance(AUTOSAVE_MS);
    type('abc');
    await clock.advance(20_000);
    expect(file.writes.map((w) => [w.text, w.base])).toEqual([['a', 'v1'], ['abc', 'v2']]);
    expect(file.text).toBe('abc');
    expect(statuses.at(-1)).toBe('saved');
    expect(statuses).not.toContain('conflict');
  });

  test('two saves never start closer than SAVE_GAP_MS', async () => {
    const { clock, file, type, saver } = setup();
    for (let i = 1; i <= 5; i++) {
      type(`t${i}`);
      saver.flush();
      await clock.advance(200);
    }
    await clock.advance(20_000);
    const starts = file.writes.map((w) => w.startedAt);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(SAVE_GAP_MS);
    expect(file.text).toBe('t5');
  });

  test('a new version with the same text (the mount merge) is taken without a conflict', async () => {
    const { clock, file, type, conflicts } = setup();
    type('one');
    await clock.advance(AUTOSAVE_MS);
    file.replace('one');
    type('two');
    await clock.advance(AUTOSAVE_MS + SAVE_GAP_MS + 1_000);
    expect(file.text).toBe('two');
    expect(conflicts()).toBe(0);
  });

  test('an older text of this tab coming back is overwritten, also when the editor is idle', async () => {
    const { clock, file, type, conflicts } = setup();
    type('one');
    await clock.advance(AUTOSAVE_MS);
    type('two');
    await clock.advance(AUTOSAVE_MS + SAVE_GAP_MS);
    expect(file.text).toBe('two');
    file.replace('one');
    await clock.advance(VERIFY_MS + SAVE_GAP_MS + 100);
    expect(file.text).toBe('two');
    expect(conflicts()).toBe(0);
  });

  test('a text no one in this tab wrote is a conflict: one prompt, autosave stops, Keep mine writes over it', async () => {
    const { clock, file, type, saver, statuses, conflicts } = setup();
    file.replace('agent');
    type('mine');
    await clock.advance(AUTOSAVE_MS);
    expect(conflicts()).toBe(1);
    expect(statuses.at(-1)).toBe('conflict');
    type('mine more');
    await clock.advance(30_000);
    expect(file.writes).toHaveLength(1);
    expect(file.text).toBe('agent');
    saver.keepMine();
    await clock.advance(100);
    expect(file.text).toBe('mine more');
    expect(statuses.at(-1)).toBe('saved');
  });

  test('a failed save keeps the edit and retries with backoff', async () => {
    const { clock, file, type, statuses } = setup();
    const write = file.write;
    let down = 2;
    file.write = async (text, base) => {
      if (down-- > 0) throw new Error('Failed to fetch');
      return write(text, base);
    };
    type('offline');
    await clock.advance(AUTOSAVE_MS);
    expect(statuses.at(-1)).toBe('error');
    await clock.advance(5_000);
    expect(file.text).toBe('start');
    await clock.advance(10_000);
    expect(file.text).toBe('offline');
    expect(statuses.at(-1)).toBe('saved');
  });

  test('closing mid-save hands the outcome to the next editor of the doc; a closed editor never writes on its own', async () => {
    const { clock, file, type, saver, artifactId } = setup();
    file.latency = 1_000;
    type('last words');
    saver.close();
    const handed = pendingSave(artifactId);
    expect(handed).toBeDefined();
    await clock.advance(1_000);
    expect(await handed).toEqual({ version: file.version(), text: 'last words' });
    expect(pendingSave(artifactId)).toBeUndefined();
    // A restore puts an older text back: the closed editor leaves it.
    file.replace('start');
    await clock.advance(VERIFY_MS * 2);
    expect(file.text).toBe('start');
  });
});
