import { describe, expect, test } from 'bun:test';
import { MermaidRenderQueue } from './mermaid-render-queue';

const SVG = '<svg id="kortix-mermaid-1" width="100%" viewBox="0 0 200 100" style="max-width: 200px;"></svg>';

function setup(timeoutMs = 10_000) {
  const queue = new MermaidRenderQueue(timeoutMs);
  const sent: { id: number; chart: string }[] = [];
  const inject = (script: string) => {
    const match = /^window\.__kortixMermaidRender\((.*)\);true;$/.exec(script);
    if (!match) throw new Error(`unexpected script ${script}`);
    sent.push(JSON.parse(match[1]));
  };
  return { queue, sent, inject };
}

describe('MermaidRenderQueue', () => {
  test('holds requests until the renderer is ready, then resolves from its answer', async () => {
    const { queue, sent, inject } = setup();
    let wanted = 0;
    queue.subscribe(() => wanted++);
    const result = queue.render('graph TD\n  A --> B');
    expect(queue.isWanted()).toBe(true);
    expect(wanted).toBe(1);
    expect(sent).toEqual([]);

    queue.attach(inject);
    expect(sent).toEqual([{ id: 1, chart: 'graph TD\n  A --> B' }]);
    expect(queue.handleMessage(JSON.stringify({ id: 1, svg: SVG }))).toBe('result');
    expect(await result).toEqual({ ok: true, diagram: { svg: SVG, viewBox: { width: 200, height: 100 } } });
  });

  test('caches by content hash and merges concurrent requests', async () => {
    const { queue, sent, inject } = setup();
    queue.attach(inject);
    const first = queue.render('flowchart LR\n  A --> B');
    const second = queue.render('  flowchart LR\n  A --> B\n');
    expect(first).toBe(second);
    expect(sent).toHaveLength(1);
    queue.handleMessage(JSON.stringify({ id: sent[0].id, svg: SVG }));
    await first;
    expect(queue.peek('flowchart LR\n  A --> B')?.ok).toBe(true);
    await queue.render('flowchart LR\n  A --> B');
    expect(sent).toHaveLength(1);
  });

  test('Mermaid errors are cached, unknown types map to web value', async () => {
    const { queue, sent, inject } = setup();
    queue.attach(inject);
    const result = queue.render('graph TD\n  A -->');
    queue.handleMessage(JSON.stringify({ id: sent[0].id, error: 'Parse error on line 2' }));
    expect(await result).toEqual({ ok: false, error: 'Parse error on line 2' });
    expect(queue.peek('graph TD\n  A -->')).toEqual({ ok: false, error: 'Parse error on line 2' });

    const unknown = queue.render('pie showData\n  "a": 1');
    queue.handleMessage(JSON.stringify({ id: sent[1].id, error: 'UnknownDiagramError: No diagram type detected' }));
    expect(await unknown).toEqual({ ok: false, error: 'unsupported_diagram_type' });
  });

  test('a chart web rejects before rendering never reaches the WebView', async () => {
    const { queue, sent, inject } = setup();
    queue.attach(inject);
    expect(await queue.render('xychart-beta\n  bar [1, 2]')).toEqual({ ok: false, error: 'Invalid diagram type' });
    expect(sent).toEqual([]);
    expect(queue.isWanted()).toBe(false);
  });

  test('re-sends unanswered requests after the renderer process restarts', async () => {
    const { queue, sent, inject } = setup();
    queue.attach(inject);
    const result = queue.render('sequenceDiagram\n  A->>B: hi');
    expect(sent).toHaveLength(1);
    queue.detach();
    queue.attach(inject);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    queue.handleMessage(JSON.stringify({ id: sent[1].id, svg: SVG }));
    expect((await result).ok).toBe(true);
  });

  test('times out without caching, so a later mount retries', async () => {
    const { queue, sent, inject } = setup(20);
    queue.attach(inject);
    expect(await queue.render('graph TD\n  slow')).toEqual({ ok: false, error: 'timeout' });
    expect(queue.peek('graph TD\n  slow')).toBeNull();
    queue.handleMessage(JSON.stringify({ id: sent[0].id, svg: SVG }));
    expect(queue.peek('graph TD\n  slow')).toBeNull();
    void queue.render('graph TD\n  slow');
    expect(sent).toHaveLength(2);
  });

  test('a fatal renderer error fails every waiting request and lets the host retry', async () => {
    const { queue } = setup();
    const a = queue.render('graph TD\n  a');
    const b = queue.render('graph TD\n  b');
    expect(queue.handleMessage(JSON.stringify({ fatal: 'mermaid is not defined' }))).toBe('fatal');
    expect(await a).toEqual({ ok: false, error: 'mermaid is not defined' });
    expect(await b).toEqual({ ok: false, error: 'mermaid is not defined' });
    expect(queue.isWanted()).toBe(false);
    void queue.render('graph TD\n  a');
    expect(queue.isWanted()).toBe(true);
  });

  test('ignores malformed and unknown messages', () => {
    const { queue } = setup();
    expect(queue.handleMessage('not json')).toBe('ignored');
    expect(queue.handleMessage(JSON.stringify({ id: 99, svg: SVG }))).toBe('ignored');
    expect(queue.handleMessage(JSON.stringify({ ready: true, version: '11.15.0' }))).toBe('ready');
  });
});
