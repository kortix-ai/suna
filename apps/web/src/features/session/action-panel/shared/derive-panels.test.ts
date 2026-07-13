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

  it('an image_gen edit is not misreported as a newly created image — it modifies an existing image, so it is excluded from Outputs rather than shown as fresh output', () => {
    const out = deriveOutputs([part('image_gen', { action: 'edit' })]);
    expect(out).toEqual([]);
  });

  it('still reports a real image_gen generate as an output', () => {
    const out = deriveOutputs([part('image_gen', { action: 'generate' })]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('image');
  });

  it('does not report upscale/remove_bg as a newly created image either — same reasoning as edit', () => {
    for (const action of ['upscale', 'remove_bg']) {
      expect(deriveOutputs([part('image_gen', { action })])).toEqual([]);
    }
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
