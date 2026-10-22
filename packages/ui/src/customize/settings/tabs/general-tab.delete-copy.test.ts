import { describe, expect, test } from 'bun:test';

import { DELETE_WORKSPACE_CONSEQUENCES, DELETE_WORKSPACE_REASSURANCE } from './general-tab';

/**
 * The Delete-workspace copy is a correctness surface, not decoration: it is the
 * only place the product tells a user what they are about to lose, and it is
 * the last thing they read before an action nothing in the app can undo.
 *
 * It is tested here rather than through the rendered dialog because
 * `TypeToConfirmDialog` renders through a Radix portal, which emits nothing
 * under `renderToStaticMarkup` (`general-tab.test.tsx` pins the same constraint
 * for `ConfirmDialog`). Asserting on rendered output would produce a test that
 * cannot fail. The exported constants are the real thing.
 *
 * What these tests defend is the boundary between "true and frightening" and
 * "false and frightening" — see this tab's header comment for the traced
 * behavior each claim rests on.
 */
describe('Delete workspace copy', () => {
  test('lists every category of loss the delete actually causes', () => {
    // Sessions, automation, integrations, the managed repo, access. Each maps
    // to a traced consequence of deleting the workspace — the header comment
    // cites the file and line for all five.
    expect(DELETE_WORKSPACE_CONSEQUENCES).toHaveLength(5);
  });

  test('names sessions and their contents, not just "sessions"', () => {
    const line = DELETE_WORKSPACE_CONSEQUENCES.find((c) => c.includes('session'));
    expect(line).toBeDefined();
    expect(line).toContain('files');
    expect(line).toContain('history');
  });

  test('warns that scheduled automation stops', () => {
    // Verified: triggers only fire for `status = 'active'`, so a user with
    // production schedules on this workspace loses them the moment they
    // confirm. Omitting this is how someone silently breaks a pipeline.
    const line = DELETE_WORKSPACE_CONSEQUENCES.find((c) => c.includes('trigger'));
    expect(line).toBeDefined();
    expect(line).toContain('scheduled');
  });

  test('warns that integrations, secrets and API keys stop working', () => {
    const line = DELETE_WORKSPACE_CONSEQUENCES.find((c) => c.includes('integration'));
    expect(line).toBeDefined();
    expect(line).toContain('secret');
    expect(line).toContain('API key');
  });

  test('states that the loss is team-wide, not just the actor’s own access', () => {
    const line = DELETE_WORKSPACE_CONSEQUENCES.find((c) => c.includes('Access'));
    expect(line).toBeDefined();
    expect(line).toContain('team');
  });

  /**
   * The single most important assertion in this file.
   *
   * Deleting the workspace deletes the Kortix-managed repository with it
   * (`deleteManagedProjectRepo` runs on every project delete). A dialog that
   * says "permanent" while staying silent about the repo is read as "my code
   * is safe" — false for a managed repo, and the opposite of what a user
   * needs to know before confirming.
   */
  test('warns that the managed git repository goes with the workspace', () => {
    const line = DELETE_WORKSPACE_CONSEQUENCES.find((c) => c.includes('repository'));
    expect(line).toBeDefined();
    expect(line).toContain('Kortix-managed');
    expect(line).toContain('commit');
  });

  /**
   * The connected-repo boundary. `deleteManagedProjectRepo` deletes only the
   * Kortix-managed upstream; a repository the user connected themselves is
   * never touched. "Permanent" plus silence about that reads as "my code is
   * gone", which is false for a connected repo and the thing a user panics
   * about first, so the reassurance is not optional polish.
   */
  test('reassures that user-connected repositories survive', () => {
    expect(DELETE_WORKSPACE_REASSURANCE).toContain('connected yourself');
    expect(DELETE_WORKSPACE_REASSURANCE).toContain('not deleted');
  });

  /**
   * The honesty boundary. The workspace row is archived, not erased — support
   * and platform admins can still see it. The copy may say access is gone
   * forever (true, and there is no un-archive path anywhere in the product),
   * but it must never claim the data itself was destroyed or wiped, which
   * would be a promise the backend does not keep.
   */
  test('never claims the data is erased, wiped, or destroyed', () => {
    const all = [...DELETE_WORKSPACE_CONSEQUENCES, DELETE_WORKSPACE_REASSURANCE]
      .join(' ')
      .toLowerCase();
    for (const forbidden of ['erased', 'erase', 'wiped', 'wipe', 'destroyed', 'shredded']) {
      expect(all).not.toContain(forbidden);
    }
  });

  test('every line is plain prose — no empty entries, no trailing punctuation drift', () => {
    for (const line of DELETE_WORKSPACE_CONSEQUENCES) {
      expect(line.trim()).toBe(line);
      expect(line.length).toBeGreaterThan(0);
      // List items are fragments, not sentences — a stray full stop on one of
      // four bullets is the kind of drift nobody notices in review.
      expect(line.endsWith('.')).toBe(false);
    }
  });
});
