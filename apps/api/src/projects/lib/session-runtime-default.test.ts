/**
 * WHICH RUNTIME A SESSION BOOTS, AND WHO GETS TO DECIDE.
 *
 * Two gates stand between a project and the pi worker: the `pi_worker` feature
 * flag and the manifest's runtime. Both defaulted to "no", and on a deployment
 * that exists to run pi that is the wrong default twice over. Every project
 * seeded from the v2 starter — `kortix_version: 2`, no `runtime:` line, which
 * is what `general-knowledge-worker` scaffolds — resolved to `opencode` and
 * booted a microVM.
 *
 * MEASURED on the dev stack 2026-09-07, project 97a2a697 "My First Project":
 * seeded v2 with no flag, its session 35188845 ran as `runtime: microvm`,
 * ram_mb 2048, memCurrentBytes 1.42 GB — against a cell's 1.38 MiB — and none
 * of the cell's own filesystem or shell. Nothing reported a problem: the flag
 * was simply off, so the manifest was never even read.
 *
 * The rule these claims pin: a manifest that NAMES a runtime is obeyed in both
 * directions, and the deployment default speaks only into the silence.
 */
import { describe, expect, test } from 'bun:test';
import { sessionRuntimeFor, type ManifestRuntimeReading } from './compile-agent-config';

const declared = (runtime: 'pi' | 'opencode'): ManifestRuntimeReading => ({ kind: 'declared', runtime });
const defaulted = (runtime: 'pi' | 'opencode', version: number): ManifestRuntimeReading => ({
  kind: 'default',
  runtime,
  version,
});
const none: ManifestRuntimeReading = { kind: 'none' };

describe('the runtime a session boots under', () => {
  test('a v2 manifest that names nothing boots PI on a pi deployment — the microVM bug', () => {
    // The exact shape of project 97a2a697: kortix_version 2, no runtime line.
    expect(sessionRuntimeFor(defaulted('opencode', 2), true)).toBe('pi');
    // …and is unchanged anywhere else, so kortix.com keeps booting OpenCode.
    expect(sessionRuntimeFor(defaulted('opencode', 2), false)).toBe('opencode');
  });

  test('`runtime: opencode` is honoured EVEN on a pi deployment — a project may opt out', () => {
    expect(sessionRuntimeFor(declared('opencode'), true)).toBe('opencode');
    expect(sessionRuntimeFor(declared('opencode'), false)).toBe('opencode');
  });

  test('`runtime: pi` is honoured everywhere, deployment default or not', () => {
    expect(sessionRuntimeFor(declared('pi'), false)).toBe('pi');
    expect(sessionRuntimeFor(declared('pi'), true)).toBe('pi');
  });

  test('a v3 manifest already defaults to pi, with or without the switch', () => {
    expect(sessionRuntimeFor(defaulted('pi', 3), false)).toBe('pi');
    expect(sessionRuntimeFor(defaulted('pi', 3), true)).toBe('pi');
  });

  test('no readable modern manifest stays null — a switch must not migrate a v1 project', () => {
    // `none` covers a missing file, an unreadable ref, a parse error and a
    // pre-v2 body alike. Answering `pi` here would move legacy projects onto a
    // runtime their repo was never written for.
    expect(sessionRuntimeFor(none, true)).toBeNull();
    expect(sessionRuntimeFor(none, false)).toBeNull();
  });
});
