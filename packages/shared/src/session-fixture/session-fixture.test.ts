import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FIXTURE_MARKDOWN_DOCUMENT,
  FIXTURE_MARKDOWN_FENCES,
  FIXTURE_TOOL_GROUPS,
  SESSION_FIXTURE,
  buildSessionFixture,
} from './index';
import type { FixtureMessageWithParts, FixturePart, FixturePartType, FixtureToolPart, FixtureToolStatus } from './types';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const WEB_TOOLS_DIR = join(REPO_ROOT, 'apps/web/src/features/session/tool/tools');

const PART_TYPES: FixturePartType[] = [
  'text',
  'subtask',
  'reasoning',
  'file',
  'tool',
  'step-start',
  'step-finish',
  'snapshot',
  'patch',
  'agent',
  'retry',
  'compaction',
];
const STATES: FixtureToolStatus[] = ['pending', 'running', 'completed', 'error'];

/** The `./x` imports of web `register.ts`, as renderer file names. */
function webRendererFiles(): string[] {
  const source = readFileSync(join(WEB_TOOLS_DIR, 'register.ts'), 'utf8');
  return [...source.matchAll(/^import\s+'\.\/([^']+)';/gm)].map((m) => `${m[1]}.tsx`).sort();
}

/** Tool names one web renderer file registers: direct literals and `[…].forEach` arrays. */
function webRegisteredNames(file: string): Set<string> {
  const code = readFileSync(join(WEB_TOOLS_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const names = new Set<string>();
  for (const m of code.matchAll(/ToolRegistry\.register\(\s*(['"])([^'"]+)\1\s*,/g)) names.add(m[2]);
  for (const m of code.matchAll(/\[([^[\]]*)\]\s*\.forEach\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*ToolRegistry\.register\(\s*\2\s*,/g)) {
    for (const lit of m[1].matchAll(/(['"])([^'"]+)\1/g)) names.add(lit[2]);
  }
  return names;
}

function allMessages(): FixtureMessageWithParts[] {
  return [SESSION_FIXTURE.messages, ...Object.values(SESSION_FIXTURE.childSessions)].flat();
}

function rootParts(): FixturePart[] {
  return SESSION_FIXTURE.messages.flatMap((m) => m.parts);
}

function rootToolParts(): FixtureToolPart[] {
  return rootParts().filter((p): p is FixtureToolPart => p.type === 'tool');
}

describe('session fixture — structure', () => {
  test('two builds are deep-equal (no clock, no randomness)', () => {
    expect(buildSessionFixture()).toEqual(SESSION_FIXTURE);
  });

  test('message, part, and call ids are unique across the root and child sessions', () => {
    const messages = allMessages();
    const messageIds = messages.map((m) => m.info.id);
    const partIds = messages.flatMap((m) => m.parts.map((p) => p.id));
    const callIds = messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'tool' ? [p.callID] : [])));
    expect(new Set(messageIds).size).toBe(messageIds.length);
    expect(new Set(partIds).size).toBe(partIds.length);
    expect(new Set(callIds).size).toBe(callIds.length);
  });

  test('every part points at its message and session; ids are wire-shaped', () => {
    for (const [sessionId, messages] of [
      [SESSION_FIXTURE.sessionId, SESSION_FIXTURE.messages] as const,
      ...Object.entries(SESSION_FIXTURE.childSessions),
    ]) {
      expect(sessionId).toMatch(/^ses_[A-Za-z0-9]+$/);
      for (const message of messages) {
        expect(message.info.id).toMatch(/^msg_[0-9a-f]{12}/);
        expect(message.info.sessionID).toBe(sessionId);
        for (const part of message.parts) {
          expect(part.messageID).toBe(message.info.id);
          expect(part.sessionID).toBe(sessionId);
        }
      }
    }
  });

  test('root messages are in display order and every assistant parent exists', () => {
    const ids = SESSION_FIXTURE.messages.map((m) => m.info.id);
    expect([...ids].sort()).toEqual(ids);
    const userIds = new Set(SESSION_FIXTURE.messages.filter((m) => m.info.role === 'user').map((m) => m.info.id));
    for (const { info } of SESSION_FIXTURE.messages) {
      if (info.role === 'assistant') expect(userIds.has(info.parentID)).toBe(true);
    }
  });

  test('every SDK part type is present in the root session', () => {
    const present = new Set(rootParts().map((p) => p.type));
    expect([...present].sort()).toEqual([...PART_TYPES].sort());
  });

  test('reasoning is present finished and streaming', () => {
    const reasoning = rootParts().filter((p) => p.type === 'reasoning');
    expect(reasoning.some((p) => p.type === 'reasoning' && p.time.end !== undefined)).toBe(true);
    expect(reasoning.some((p) => p.type === 'reasoning' && p.time.end === undefined)).toBe(true);
  });

  test('the fixture never names a localhost port (web probes those URLs over the network)', () => {
    expect(JSON.stringify(SESSION_FIXTURE)).not.toMatch(/(localhost|127\.0\.0\.1):\d+/);
  });
});

describe('session fixture — tool coverage', () => {
  const rendererFiles = webRendererFiles();
  const specs = FIXTURE_TOOL_GROUPS.flatMap((g) => g.specs);

  test('web registers the renderer files this test reads (the sweep is not silently empty)', () => {
    expect(rendererFiles.length).toBeGreaterThan(50);
  });

  test('every web renderer file has at least one spec', () => {
    const covered = new Set(specs.map((s) => s.renderer));
    expect(rendererFiles.filter((file) => !covered.has(file))).toEqual([]);
  });

  test('every spec names a real renderer file and a tool name that file registers', () => {
    for (const spec of specs) {
      expect(existsSync(join(WEB_TOOLS_DIR, spec.renderer))).toBe(true);
      // Both registries look a name up as written and with `_` and `-` swapped
      // (`ToolRegistry.get`), so the wire's `image_search` resolves `image-search`.
      const names = webRegisteredNames(spec.renderer);
      const registered = [spec.tool, spec.tool.replace(/_/g, '-'), spec.tool.replace(/-/g, '_')].some((n) => names.has(n));
      expect({ renderer: spec.renderer, tool: spec.tool, registered }).toEqual({
        renderer: spec.renderer,
        tool: spec.tool,
        registered: true,
      });
    }
  });

  test('every renderer file is rendered in all four states', () => {
    const statesByRenderer = new Map<string, Set<FixtureToolStatus>>();
    for (const entry of SESSION_FIXTURE.toolCoverage) {
      const states = statesByRenderer.get(entry.renderer) ?? new Set<FixtureToolStatus>();
      for (const state of entry.states) states.add(state);
      statesByRenderer.set(entry.renderer, states);
    }
    const incomplete = rendererFiles.filter((file) => STATES.some((state) => !statesByRenderer.get(file)?.has(state)));
    expect(incomplete).toEqual([]);
  });

  test('every declared state of every spec exists as a tool part in the root session', () => {
    const parts = rootToolParts();
    for (const entry of SESSION_FIXTURE.toolCoverage) {
      for (const state of entry.states) {
        const found = parts.some((p) => p.tool === entry.tool && p.state.status === state);
        expect({ tool: entry.tool, state, found }).toEqual({ tool: entry.tool, state, found: true });
      }
    }
  });

  test('structured outputs are valid JSON strings', () => {
    for (const spec of specs) {
      const output = spec.output.trim();
      if (output.startsWith('{') || output.startsWith('[')) expect(() => JSON.parse(output)).not.toThrow();
    }
  });

  test('every child session is referenced by a root tool part', () => {
    const serialized = rootToolParts().map((p) => JSON.stringify(p.state));
    for (const childId of Object.keys(SESSION_FIXTURE.childSessions)) {
      expect({ childId, referenced: serialized.some((s) => s.includes(childId)) }).toEqual({ childId, referenced: true });
    }
    expect(Object.keys(SESSION_FIXTURE.childSessions).length).toBeGreaterThan(0);
  });
});

describe('session fixture — scenarios', () => {
  test('the markdown document carries every block class', () => {
    const doc = FIXTURE_MARKDOWN_DOCUMENT;
    for (const level of [1, 2, 3, 4, 5, 6]) expect(doc).toMatch(new RegExp(`^${'#'.repeat(level)} \\S`, 'm'));
    for (const lang of FIXTURE_MARKDOWN_FENCES) expect(doc).toContain(`\`\`\`${lang}\n`);
    expect(doc).toMatch(/^\| .* \|$/m);
    expect(doc).toMatch(/^> /m);
    expect(doc).toMatch(/^1\. /m);
    expect(doc).toMatch(/^- \[x\] /m);
    expect(doc).toMatch(/^\$\$$/m);
    expect(doc).toMatch(/[^$]\$[^$\n]+\$[^$]/);
    expect(doc).toContain('flowchart TD');
    expect(doc).toContain('sequenceDiagram');
    for (const code of ['`leader`', '`/workspace/', '`https://', '`#0ea5e9`']) expect(doc).toContain(code);
    expect(rootParts().some((p) => p.type === 'text' && p.text === doc)).toBe(true);
  });

  test('the first user message has a mention, one image, three uploads, and long text', () => {
    const first = SESSION_FIXTURE.messages[0]!;
    expect(first.info.role).toBe('user');
    const text = first.parts.find((p) => p.type === 'text');
    expect(text?.type === 'text' && text.text.length > 800).toBe(true);
    expect(text?.type === 'text' && /(^|\s)@src\//.test(text.text)).toBe(true);
    expect(text?.type === 'text' ? (text.text.match(/<file path="/g) ?? []).length : 0).toBe(3);
    const images = first.parts.filter((p) => p.type === 'file' && p.mime.startsWith('image/'));
    expect(images.length).toBe(1);
    expect(images[0]?.type === 'file' && images[0].url.startsWith('data:image/png;base64,')).toBe(true);
    expect(first.parts.some((p) => p.type === 'agent' && SESSION_FIXTURE.agentNames.includes(p.name))).toBe(true);
  });

  test('error turns: provider error with gateway envelope, insufficient credits, usage limit, abort', () => {
    const errors = SESSION_FIXTURE.messages.flatMap((m) => (m.info.role === 'assistant' && m.info.error ? [m.info.error] : []));
    const messages = errors.map((e) => e.data.message ?? '');
    expect(errors.some((e) => e.name === 'APIError' && typeof e.data.responseBody === 'string' && e.data.responseBody.includes('"request_id"'))).toBe(true);
    expect(messages.some((m) => /insufficient credits/i.test(m))).toBe(true);
    expect(messages.some((m) => /free usage exceeded/i.test(m))).toBe(true);
    expect(errors.some((e) => e.name === 'MessageAbortedError')).toBe(true);
  });

  test('compaction: a request marker and a landed summary message', () => {
    expect(rootParts().some((p) => p.type === 'compaction')).toBe(true);
    expect(SESSION_FIXTURE.messages.some((m) => m.info.role === 'assistant' && m.info.summary === true && m.info.time.completed)).toBe(true);
  });

  test('queue states: one interrupted and one queued user message with no reply', () => {
    const states = Object.entries(SESSION_FIXTURE.queueStates);
    expect(states.map(([, s]) => s).sort()).toEqual(['interrupted', 'queued']);
    for (const [id] of states) {
      const message = SESSION_FIXTURE.messages.find((m) => m.info.id === id);
      expect(message?.info.role).toBe('user');
      expect(SESSION_FIXTURE.messages.some((m) => m.info.role === 'assistant' && m.info.parentID === id)).toBe(false);
    }
  });

  test('working turn: an open assistant message, the pending question, and the pending permission', () => {
    const { userMessageId } = SESSION_FIXTURE.working;
    const open = SESSION_FIXTURE.messages.filter(
      (m) => m.info.role === 'assistant' && m.info.parentID === userMessageId && m.info.time.completed === undefined,
    );
    expect(open.length).toBe(1);
    const running = open[0]!.parts.filter((p): p is FixtureToolPart => p.type === 'tool');
    const [question] = SESSION_FIXTURE.questions;
    const [permission] = SESSION_FIXTURE.permissions;
    expect(running.find((p) => p.callID === question?.tool?.callID)?.tool).toBe('question');
    expect(running.find((p) => p.callID === permission?.tool?.callID)?.tool).toBe('bash');
    expect(SESSION_FIXTURE.working.retryStatus.type).toBe('retry');
  });
});
