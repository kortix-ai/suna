import { describe, expect, test } from 'bun:test';
import type { CanvasMessage, CanvasSecurityPatchMessage } from '../canvas/types';
import { canvasEmit } from '../canvas/emitter';

describe('CanvasMessage types', () => {
  test('security_patch message satisfies CanvasMessage union', () => {
    const msg: CanvasMessage = {
      type: 'canvas',
      kind: 'security_patch',
      id: 'test-id',
      data: {
        cve: 'CVE-2024-1234',
        package: 'lodash',
        severity: 'high',
        fixedIn: '4.17.22',
        currentVersion: '4.17.20',
      },
    };
    // Narrowing works via kind discriminator
    if (msg.kind === 'security_patch') {
      expect(msg.data.cve).toBe('CVE-2024-1234');
      expect(msg.data.package).toBe('lodash');
      expect(msg.data.severity).toBe('high');
      expect(msg.data.fixedIn).toBe('4.17.22');
    }
  });

  test('canvasEmit writes correct SSE event format', async () => {
    const decoder = new TextDecoder();
    const written: string[] = [];

    // Mock writer — captures what canvasEmit encodes without real stream overhead
    const mockWriter = {
      write: async (chunk: Uint8Array) => { written.push(decoder.decode(chunk)); },
    } as WritableStreamDefaultWriter<Uint8Array>;

    const msg: CanvasMessage = {
      type: 'canvas',
      kind: 'table',
      id: 'tbl-1',
      data: { columns: ['a', 'b'], rows: [[1, 2]] },
    };

    await canvasEmit(mockWriter, msg);

    const result = written.join('');
    expect(result).toContain('event: canvas\n');
    expect(result).toContain('"kind":"table"');
    expect(result).toContain('"type":"canvas"');
    expect(result).toEndWith('\n\n');
  });
});
