import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

/**
 * Characterization for KRTX-772: the preview cards under an assistant message
 * are driven by the shared localhost detector. TextPartBlock, SandboxPreviewCard
 * and the detector run for real — only the native/visual leaves are stubbed —
 * so the suite pins the behavior across the detector swap.
 *
 * Bun cannot load the native modules the render graph reaches, and its module
 * mocks are process-wide, so the render probe runs in a child `bun test`
 * process where the stubs are pristine and cannot leak into the rest of the
 * suite (the same pattern `tool/tools/conformance.test.ts` uses).
 */
const PROBE_ENV = 'TEXT_PART_PROBE';
const PROBE_OUT_ENV = 'TEXT_PART_PROBE_OUT';
const MOBILE_ROOT = join(import.meta.dir, '..', '..', '..', '..');

interface RowProps {
  title: string;
  subtitle: string;
  accessibilityLabel?: string;
}

if (process.env[PROBE_ENV] === '1') {
  const rows: RowProps[] = [];
  let done = 0;

  mock.module('react-native', () => ({ View: ({ children }: any) => children }));
  mock.module('@/components/kortix/selectable-markdown', () => ({
    SelectableMarkdownText: ({ children }: any) => children,
  }));
  // SetupLinkCard pulls the RNR primitives (not loadable under bun); prose
  // without a /connect link never renders it.
  mock.module('./setup-link-card', () => ({ SetupLinkCard: () => null }));
  mock.module('@/components/session/tool/shared/result-row', () => ({
    ResultRow: (props: any) => {
      rows.push(props);
      return null;
    },
  }));
  mock.module('expo-haptics', () => ({
    impactAsync: async () => {},
    ImpactFeedbackStyle: { Light: 'light' },
  }));
  mock.module('@/components/session/tool/shared/navigation', () => ({
    useToolNavigation: () => ({ openPreview: async () => {} }),
  }));
  mock.module('@/contexts/SandboxContext', () => ({
    useSandboxContext: () => ({ sandboxId: 'sb-test' }),
  }));
  mock.module('@/lib/icons', () => ({ MonitorIcon: 'MonitorIcon' }));
  mock.module('@/lib/platform/client', () => ({
    getSandboxPortUrl: (sandboxId: string, port: string) => `https://preview.test/p/${sandboxId}/${port}`,
  }));

  let TextPartBlock: (typeof import('./text-part'))['TextPartBlock'];
  let tree: ReactTestRenderer | undefined;

  beforeAll(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    TextPartBlock = (await import('./text-part')).TextPartBlock;
  });
  afterAll(() => {
    const out = process.env[PROBE_OUT_ENV];
    if (out) writeFileSync(out, JSON.stringify({ done }));
  });

  async function renderText(text: string): Promise<RowProps[]> {
    rows.length = 0;
    await act(async () => {
      tree = create(React.createElement(TextPartBlock, { text, isDark: false }));
    });
    return rows;
  }

  describe('TextPartBlock preview cards', () => {
    test('one card per localhost URL in prose, named by its port and path', async () => {
      const rendered = await renderText('UI at https://localhost:3000 — API docs at http://localhost:8080/docs live');
      expect(rendered).toHaveLength(2);
      for (const row of rendered) {
        expect(row.title).toBe('App preview');
        expect(row.accessibilityLabel).toContain('localhost:');
      }
      expect(rendered.map((row) => row.subtitle)).toContain('localhost:8080/docs');
      done += 1;
    });

    test('repeats of the same URL collapse to one card', async () => {
      const rendered = await renderText('Run http://localhost:3000 then visit http://localhost:3000.');
      expect(rendered).toHaveLength(1);
      expect(rendered[0].accessibilityLabel).toContain('localhost:3000');
      done += 1;
    });

    test('a localhost URL inside a code fence still renders a card', async () => {
      const rendered = await renderText('```\ncurl http://localhost:5173/vite\n```');
      expect(rendered).toHaveLength(1);
      expect(rendered[0].subtitle).toBe('localhost:5173/vite');
      done += 1;
    });

    test('non-localhost text renders no card', async () => {
      const rendered = await renderText('Deployed at https://kortix.com/docs; localhost:3000 and 127.0.0.1:9000 without a scheme are not URLs.');
      expect(rendered).toHaveLength(0);
      done += 1;
    });
  });
} else {
  test('TextPartBlock renders one preview card per localhost URL (isolated probe)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'text-part-probe-'));
    const out = join(dir, 'result.json');
    try {
      const child = Bun.spawnSync(
        [process.execPath, 'test', `./${relative(MOBILE_ROOT, import.meta.path)}`],
        {
          cwd: MOBILE_ROOT,
          env: { ...process.env, [PROBE_ENV]: '1', [PROBE_OUT_ENV]: out },
          stdout: 'ignore',
          stderr: 'ignore',
        },
      );
      if (!existsSync(out)) throw new Error(`text-part probe wrote no result (exit ${child.exitCode})`);
      const result = JSON.parse(readFileSync(out, 'utf8')) as { done?: number };
      expect(result.done).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
}
