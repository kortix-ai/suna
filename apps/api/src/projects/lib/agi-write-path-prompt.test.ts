/**
 * The AGI's write path is carried ENTIRELY by its prompt.
 *
 * Nothing server-side enforces "changes land only through a change request":
 * the git proxy maps `git-receive-pack` to a plain write with no ref-level
 * protection, and the AGI's grant (`kortixCli: 'all'`) even satisfies
 * `project.cr.merge`. So the four rules that keep R-9.6 true — always pass
 * `--head`, never `kortix ship`, never self-merge, never `git add -A` — exist
 * only as words in `packages/starter/templates/agi/agents/kortix-agi.md`.
 *
 * That file is a shipped platform artifact, not documentation: it is compiled
 * by `agiOpencodeAgentConfig()` and injected into every AGI session through
 * `KORTIX_COMPILED_AGENT_CONFIG`. Asserting on the compiled body is therefore a
 * behavioral test of what the runtime hands the model, not a string test of a
 * doc.
 *
 * Why the negative assertions matter more than the positive ones: an
 * instruction the runtime cannot honor ("your working directory is scratch
 * space, there is no codebase here") teaches the AGI it cannot write at all,
 * and a `kortix ship` teaches it to push straight to the default branch —
 * ship pushes the branch you are standing on, and a fresh clone stands on the
 * default branch. Both are worse than silence. This test is the guard against
 * the prompt drifting back to either.
 */
import { describe, expect, test } from 'bun:test';
import { agiOpencodeAgentConfig } from './agi-agent-behavior';

function agiPrompt(): string {
  const compiled = agiOpencodeAgentConfig();
  // A null here is a packaging defect (the bundled template failed to embed),
  // which would ship every AGI session without any operating rules at all.
  expect(compiled).not.toBeNull();
  const prompt = compiled?.prompt;
  expect(typeof prompt).toBe('string');
  return prompt as string;
}

describe('AGI prompt — the write path it actually has', () => {
  test('names every command of the clone → branch → push → CR path', () => {
    const prompt = agiPrompt();
    expect(prompt).toContain('kortix projects clone');
    expect(prompt).toContain('git switch -c');
    expect(prompt).toContain('kortix cr open');
    // Without an explicit --head, `kortix cr open` falls back to
    // $KORTIX_BRANCH_NAME (the SESSION branch, not the branch just pushed) and
    // the open 422s with CR_HEAD_NOT_AHEAD.
    expect(prompt).toContain('--head');
  });

  test('delivers the review ask instead of writing it into a session log', () => {
    const prompt = agiPrompt();
    // A trigger-fired push at 07:00 has no reader. `kortix tasks request` is
    // the only thing that reaches a human (Slack DM, else `tasks waiting`).
    expect(prompt).toContain('kortix tasks request');
    expect(prompt).toContain('--kind decision');
  });

  test('forbids self-merging its own change request', () => {
    const prompt = agiPrompt();
    // The grant permits it; only this sentence stops it.
    expect(prompt).toContain('Never merge your own change request');
  });

  test('forbids `git add -A` in a manifest change request', () => {
    expect(agiPrompt()).toContain('never `git add -A`');
  });

  test('no longer claims the AGI has nowhere to write', () => {
    const prompt = agiPrompt();
    expect(prompt).not.toContain('scratch space');
    expect(prompt).not.toContain('there is no codebase here');
  });

  test('mentions `kortix ship` ONLY to forbid it, never as a command to run', () => {
    const prompt = agiPrompt();
    // The rule has to name the command to be effective, so a blanket
    // "does not contain" assertion would be self-defeating. Assert the
    // stronger property instead: the single mention is the prohibition, and
    // `kortix ship` never appears at the start of a line (i.e. never inside a
    // fenced block as something to execute).
    expect(prompt.match(/kortix ship/g) ?? []).toHaveLength(1);
    expect(prompt).toContain('Never run `kortix ship`');
    expect(prompt).not.toMatch(/^\s*kortix ship\b/m);
  });

  test('tells the AGI that /workspace is not its repo', () => {
    // A warm-forked sandbox can boot with stale template content already in
    // /workspace, and with auto-clone off nothing re-materializes it. Treating
    // it as the project repo would push scaffold content over the real one.
    expect(agiPrompt()).toContain('/workspace');
  });
});
