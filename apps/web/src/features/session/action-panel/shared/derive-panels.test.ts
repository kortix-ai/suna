import { describe, expect, it } from 'bun:test';
import type { ToolPart } from '@/ui';
import { deriveContext, deriveOutputs } from './derive-panels';

function part(tool: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    type: 'tool',
    tool,
    callID: `c-${tool}-${JSON.stringify(input)}`,
    state: { status: 'completed', input },
  } as unknown as ToolPart;
}

describe('deriveOutputs', () => {
  it('is empty when the agent produced nothing', () => {
    expect(deriveOutputs([part('read', { filePath: '/a/x.ts' })])).toEqual([]);
  });

  it('collects written files', () => {
    const out = deriveOutputs([part('write', { filePath: '/a/report.md' })]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('report.md');
    expect(out[0].kind).toBe('file');
  });

  it('collects generated media', () => {
    const out = deriveOutputs([
      part('image_gen', { action: 'generate' }),
      part('presentation_gen', { action: 'create_slide' }),
    ]);
    expect(out.map((o) => o.kind)).toEqual(['image', 'presentation']);
  });

  it('deduplicates a file written more than once', () => {
    const out = deriveOutputs([
      part('write', { filePath: '/a/report.md' }),
      part('edit', { filePath: '/a/report.md' }),
    ]);
    expect(out).toHaveLength(1);
  });

  // ─── action-multiplexed tools: image_gen/presentation_gen dispatch on
  // `input.action` across genuinely different operations. A naive "every
  // call to this tool name is an output" rule would show a deleted
  // presentation, or a mere listing of presentations, as something the agent
  // MADE — it must not. ───────────────────────────────────────────────────

  it('does not report a deleted presentation as an output', () => {
    const out = deriveOutputs([
      part('presentation_gen', { action: 'delete_presentation', presentation_name: 'demo' }),
    ]);
    expect(out).toEqual([]);
  });

  it('does not report list_presentations (a pure read) as an output', () => {
    const out = deriveOutputs([part('presentation_gen', { action: 'list_presentations' })]);
    expect(out).toEqual([]);
  });

  it('does not report a deleted slide as an output', () => {
    const out = deriveOutputs([part('presentation_gen', { action: 'delete_slide' })]);
    expect(out).toEqual([]);
  });

  it('does not report list_slides/validate_slide/preview (reads) as outputs', () => {
    for (const action of ['list_slides', 'validate_slide', 'preview', 'serve']) {
      expect(deriveOutputs([part('presentation_gen', { action })])).toEqual([]);
    }
  });

  it('still reports create_slide and PDF/PPTX export as presentation outputs', () => {
    for (const action of ['create_slide', 'export_pdf', 'export_pptx']) {
      const out = deriveOutputs([part('presentation_gen', { action })]);
      expect(out).toHaveLength(1);
      expect(out[0].kind).toBe('presentation');
    }
  });

  // ─── image_gen: edit/upscale/remove_bg still produce a real image file —
  // the user asked to modify an existing image and got one back. The only
  // thing that was wrong to call it was the LABEL ("Made an image" would be
  // a lie for an edit); the artifact itself must still surface in Outputs,
  // or a user who asks to edit/upscale/remove a background gets an empty
  // Outputs card despite the agent actually producing something to open. ──

  it('reports an image_gen edit as an image output — editing an existing image still produces a real file to open', () => {
    const out = deriveOutputs([part('image_gen', { action: 'edit' })]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('image');
  });

  it('still reports a real image_gen generate as an output', () => {
    const out = deriveOutputs([part('image_gen', { action: 'generate' })]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('image');
  });

  it('reports upscale/remove_bg as image outputs too — same reasoning as edit', () => {
    for (const action of ['upscale', 'remove_bg']) {
      const out = deriveOutputs([part('image_gen', { action })]);
      expect(out).toHaveLength(1);
      expect(out[0].kind).toBe('image');
    }
  });

  it('reports an image_gen call with no/unrecognized action as an image output — vague-but-true bias: assume it produced something rather than hide it', () => {
    const out = deriveOutputs([part('image_gen', {})]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('image');
  });

  it('still does not report a deleted/listed presentation as an output (no regression from the image_gen fix)', () => {
    expect(
      deriveOutputs([part('presentation_gen', { action: 'delete_presentation' })]),
    ).toEqual([]);
    expect(
      deriveOutputs([part('presentation_gen', { action: 'list_presentations' })]),
    ).toEqual([]);
  });
});

describe('deriveContext', () => {
  it('partitions files, web sources, and tools', () => {
    const { files, web, tools } = deriveContext([
      part('read', { filePath: '/a/one.ts' }),
      part('read', { filePath: '/a/two.ts' }),
      part('web_fetch', { url: 'https://example.com/docs' }),
      part('bash', { command: 'ls' }),
    ]);
    expect(files).toHaveLength(2);
    expect(web).toHaveLength(1);
    expect(web[0].label).toBe('https://example.com/docs');
    expect(tools.some((t) => t.label === 'Bash')).toBe(true);
  });

  it('deduplicates a file read twice', () => {
    const { files } = deriveContext([
      part('read', { filePath: '/a/one.ts' }),
      part('read', { filePath: '/a/one.ts' }),
    ]);
    expect(files).toHaveLength(1);
  });

  it('excludes written files from context — they are outputs, not inputs', () => {
    const { files } = deriveContext([part('write', { filePath: '/a/new.md' })]);
    expect(files).toEqual([]);
  });

  // ─── hidden/engine-noise tools (familyForTool → 'hidden') must never reach
  // a non-technical user's Context card, in any of its three buckets. ──────

  it('never surfaces hidden context-engine tools in the tools bucket', () => {
    const { files, web, tools } = deriveContext([
      part('prune'),
      part('distill'),
      part('compress'),
      part('context_info'),
    ]);
    expect(tools).toEqual([]);
    expect(files).toEqual([]);
    expect(web).toEqual([]);
  });

  it('still surfaces a genuine unrecognized tool in the tools bucket (not swallowed by the hidden filter)', () => {
    const { tools } = deriveContext([part('memory', { command: 'delete', path: '/mem/x.md' })]);
    expect(tools.some((t) => t.label === 'Memory')).toBe(true);
  });
});
