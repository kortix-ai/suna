import type { ToolPart } from '@/ui';
import { describe, expect, it } from 'bun:test';
import { deriveContext, deriveOutputs } from './derive-panels';

function part(
  tool: string,
  input: Record<string, unknown> = {},
  extra: {
    metadata?: Record<string, unknown>;
    output?: string;
    status?: 'completed' | 'running' | 'pending' | 'error';
  } = {},
): ToolPart {
  const { status = 'completed', ...rest } = extra;
  return {
    type: 'tool',
    tool,
    callID: `c-${tool}-${JSON.stringify(input)}-${JSON.stringify(extra)}`,
    state: { status, input, ...rest },
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
    expect(deriveOutputs([part('presentation_gen', { action: 'delete_presentation' })])).toEqual(
      [],
    );
    expect(deriveOutputs([part('presentation_gen', { action: 'list_presentations' })])).toEqual([]);
  });

  // ─── apply_patch: the tool's INPUT is an opaque patch blob — the per-file
  // paths only exist in its OUTPUT metadata (`state.metadata.files`, the same
  // shape ApplyPatchTool itself reads — see PatchFileLite). A naive
  // `getToolPrimaryArg`-based name lookup finds nothing here (there is no
  // `apply_patch` case in that function and its input has no path-shaped
  // key), so a task that edited files via apply_patch must not come back
  // empty. ─────────────────────────────────────────────────────────────────

  it('produces one OutputItem per file an apply_patch call actually changed', () => {
    const out = deriveOutputs([
      part(
        'apply_patch',
        {},
        {
          metadata: {
            files: [
              { relativePath: 'src/a.ts', filePath: '/workspace/src/a.ts', type: 'update' },
              { relativePath: 'src/b.ts', filePath: '/workspace/src/b.ts', type: 'add' },
            ],
          },
        },
      ),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.name)).toEqual(['a.ts', 'b.ts']);
    expect(out.every((o) => o.kind === 'file')).toBe(true);
  });

  it('does not crash and emits nothing for an apply_patch call with no usable metadata', () => {
    expect(deriveOutputs([part('apply_patch', {})])).toEqual([]);
    expect(deriveOutputs([part('apply_patch', {}, { metadata: {} })])).toEqual([]);
    expect(deriveOutputs([part('apply_patch', {}, { metadata: { files: [] } })])).toEqual([]);
    expect(
      deriveOutputs([part('apply_patch', {}, { metadata: { files: [{ type: 'update' }] } })]),
    ).toEqual([]);
    expect(
      deriveOutputs([part('apply_patch', {}, { metadata: { files: 'not-an-array' } })]),
    ).toEqual([]);
  });

  it('skips a deleted file inside an apply_patch call — nothing is left to open', () => {
    const out = deriveOutputs([
      part(
        'apply_patch',
        {},
        {
          metadata: {
            files: [
              { relativePath: 'src/a.ts', filePath: '/workspace/src/a.ts', type: 'update' },
              { relativePath: 'src/gone.ts', filePath: '/workspace/src/gone.ts', type: 'delete' },
            ],
          },
        },
      ),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('a.ts');
  });

  // ─── image_gen / presentation_gen: getToolPrimaryArg has no case for these
  // tools, so the name used to fall back to humanizeToolName(part.tool) —
  // literally "Image Gen" / "Presentation Gen" instead of the artifact's own
  // name. Both components resolve the real name by parsing the tool's OUTPUT
  // payload (JSON with top-level `path`/`image_path`/`output_path`, or
  // `presentation_name`/`slide_title`) — see parseImageOutput and
  // parsePresentationOutput. ──────────────────────────────────────────────

  it('names a presentation_gen create_slide output with the real deck/slide name, not "Presentation Gen"', () => {
    const out = deriveOutputs([
      part('presentation_gen', {
        action: 'create_slide',
        presentation_name: 'Q3 Roadmap',
        slide_title: 'Overview',
        slide_number: 1,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).not.toBe('Presentation Gen');
    expect(out[0].name).toContain('Q3 Roadmap');
  });

  it('falls back to the output payload for the deck name when input lacks it', () => {
    const out = deriveOutputs([
      part(
        'presentation_gen',
        { action: 'export_pptx' },
        { output: JSON.stringify({ success: true, presentation_name: 'Q3 Roadmap' }) },
      ),
    ]);
    expect(out[0].name).toBe('Q3 Roadmap');
  });

  it('never falls back to the raw tool name for presentation_gen, even with no name anywhere', () => {
    const out = deriveOutputs([part('presentation_gen', { action: 'create_slide' })]);
    expect(out[0].name).not.toBe('Presentation Gen');
  });

  it('names an image_gen generate output something other than "Image Gen"', () => {
    const out = deriveOutputs([
      part('image_gen', { action: 'generate', prompt: 'a red panda in a garden' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).not.toBe('Image Gen');
  });

  it('uses the real output image path as the name when the tool produced one', () => {
    const out = deriveOutputs([
      part(
        'image_gen',
        { action: 'generate', prompt: 'a red panda' },
        { output: JSON.stringify({ path: '/workspace/output/panda.png' }) },
      ),
    ]);
    expect(out[0].name).toBe('panda.png');
  });

  it('never falls back to the raw tool name for image_gen, even with no name anywhere', () => {
    const out = deriveOutputs([part('image_gen', {})]);
    expect(out[0].name).not.toBe('Image Gen');
  });

  // ─── BUG 3 — a FAILED (or not-yet-finished) call must never be advertised
  // as something the agent made. The Outputs card promises "View and open
  // files created during this task"; clicking a row for a call that errored
  // fires `requestFileOpen` on a file that was never actually written. ──────

  it('never reports a write with status "error" as a created file', () => {
    expect(
      deriveOutputs([part('write', { filePath: '/a/report.md' }, { status: 'error' })]),
    ).toEqual([]);
  });

  it('never reports a write that is still "running"/"pending" — nothing was produced yet', () => {
    expect(
      deriveOutputs([part('write', { filePath: '/a/report.md' }, { status: 'running' })]),
    ).toEqual([]);
    expect(
      deriveOutputs([part('write', { filePath: '/a/report.md' }, { status: 'pending' })]),
    ).toEqual([]);
  });

  it('never reports a failed image_gen call as a produced image', () => {
    expect(deriveOutputs([part('image_gen', { action: 'generate' }, { status: 'error' })])).toEqual(
      [],
    );
  });

  it('never reports an in-flight image_gen call as a produced image', () => {
    expect(
      deriveOutputs([part('image_gen', { action: 'generate' }, { status: 'running' })]),
    ).toEqual([]);
  });

  it('never reports a failed apply_patch call as produced files', () => {
    const out = deriveOutputs([
      part(
        'apply_patch',
        {},
        {
          status: 'error',
          metadata: {
            files: [{ relativePath: 'src/a.ts', filePath: '/workspace/src/a.ts', type: 'update' }],
          },
        },
      ),
    ]);
    expect(out).toEqual([]);
  });

  it('still reports a genuinely completed write/image_gen — no regression from the status gate', () => {
    expect(
      deriveOutputs([part('write', { filePath: '/a/report.md' }, { status: 'completed' })]),
    ).toHaveLength(1);
    expect(
      deriveOutputs([part('image_gen', { action: 'generate' }, { status: 'completed' })]),
    ).toHaveLength(1);
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
    // A raw URL is exactly the kind of technical string this feature exists
    // to hide — no title was recoverable from the (empty) output, so the
    // fallback must be the human-readable domain, never the bare URL.
    expect(web[0].label).toBe('example.com');
    expect(web[0].label).not.toMatch(/^https?:\/\//);
    expect(tools.some((t) => t.label === 'Bash')).toBe(true);
  });

  // ─── BUG 1 — anything that produced an Output must never also appear in
  // Context's "Tools used" bucket. `edit` already gets this right (see the
  // test above); `create` (image_gen/video_gen/presentation_gen/show) did
  // not, so an image_gen call double-counted: once in Outputs, again as
  // "Image Gen" in Context. ───────────────────────────────────────────────

  it('never surfaces an image_gen call in Context — Outputs already owns it', () => {
    const { tools } = deriveContext([part('image_gen', { action: 'generate' })]);
    expect(tools).toEqual([]);
  });

  it('never surfaces any create-family tool (video/presentation/show) in Context, matching the edit-family exclusion', () => {
    const { tools } = deriveContext([
      part('video_gen', {}),
      part('presentation_gen', { action: 'create_slide' }),
      part('show', { type: 'markdown', content: 'hi' }),
    ]);
    expect(tools).toEqual([]);
  });

  // ─── BUG 2 — web sources must dedup by the underlying page, not by
  // whatever string happened to land in `label` — a search whose top result
  // is the exact page a later `web_fetch` call visits must collapse to ONE
  // entry, and the surviving label must be a human title or a domain, never
  // a bare URL. ─────────────────────────────────────────────────────────────

  it('collapses a searched-then-fetched same page into one web source', () => {
    const { web } = deriveContext([
      part(
        'web_search',
        { query: 'Acme Corp pricing plans 2026' },
        {
          output: JSON.stringify({
            query: 'Acme Corp pricing plans 2026',
            results: [{ title: 'Acme Corp Pricing', url: 'https://acme.example.com/pricing' }],
          }),
        },
      ),
      // Same page, different protocol/www/trailing-slash — must still collapse.
      part('web_fetch', { url: 'https://www.acme.example.com/pricing/' }),
    ]);
    expect(web).toHaveLength(1);
    expect(web[0].label).toBe('Acme Corp Pricing');
  });

  it('dedups two fetches of the same URL that only differ by protocol/www/trailing-slash', () => {
    const { web } = deriveContext([
      part('web_fetch', { url: 'http://example.com/docs/' }),
      part('web_fetch', { url: 'https://www.example.com/docs' }),
    ]);
    expect(web).toHaveLength(1);
  });

  it('never renders a bare URL as a web source label, even with no title anywhere', () => {
    const { web } = deriveContext([
      part('web_fetch', { url: 'https://acme.example.com/pricing' }),
      part('web_fetch', { url: 'https://globex.example.com/plans' }),
    ]);
    expect(web).toHaveLength(2);
    for (const w of web) {
      expect(w.label).not.toMatch(/^https?:\/\//);
    }
    expect(web.map((w) => w.label)).toEqual(['acme.example.com', 'globex.example.com']);
  });

  it('keeps distinct searches with no recoverable URL as their own entries, labeled by query', () => {
    const { web } = deriveContext([
      part('web_search', { query: 'Acme Corp pricing plans 2026' }, { output: '' }),
      part('web_search', { query: 'Globex Cloud pricing tiers comparison' }, { output: '' }),
    ]);
    expect(web).toHaveLength(2);
    expect(web.map((w) => w.label)).toEqual([
      'Acme Corp pricing plans 2026',
      'Globex Cloud pricing tiers comparison',
    ]);
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

  // ─── BUG 3 — a failed call didn't successfully look at anything, so it
  // must never surface as something the agent inspected either. ────────────

  it('never surfaces a failed read in the Context files bucket', () => {
    const { files } = deriveContext([part('read', { filePath: '/a/one.ts' }, { status: 'error' })]);
    expect(files).toEqual([]);
  });

  it('never surfaces a failed web fetch/search in the Context web bucket', () => {
    const { web } = deriveContext([
      part('web_fetch', { url: 'https://example.com/docs' }, { status: 'error' }),
    ]);
    expect(web).toEqual([]);
  });

  it('never surfaces a failed tool call in the Context tools bucket', () => {
    const { tools } = deriveContext([part('bash', { command: 'ls' }, { status: 'error' })]);
    expect(tools).toEqual([]);
  });
});

describe('deriveOutputs — running apps', () => {
  it('surfaces a running app as an output, so the user can actually reach it', () => {
    const out = deriveOutputs([
      part('show', { url: 'http://localhost:3000', title: 'Landing page' }),
    ]);
    expect(out).toHaveLength(1);
    const app = out[0];
    expect(app.kind).toBe('app');
    if (app.kind !== 'app') throw new Error('Expected a running app output');

    // Compile-time contract: narrowing to `kind: "app"` must make the URL
    // required, rather than leaving every caller to guard an optional field.
    const url: string = app.url;
    expect(url).toBe('http://localhost:3000');
    expect(app.name).toBe('Landing page');
  });

  it('falls back to host:port when the agent gave no title', () => {
    const out = deriveOutputs([part('show', { url: 'http://localhost:5173/' })]);
    expect(out[0].name).toBe('localhost:5173');
  });

  it('deduplicates the same app shown twice', () => {
    const out = deriveOutputs([
      part('show', { url: 'http://localhost:3000', title: 'App' }),
      part('show', { url: 'http://localhost:3000', title: 'App' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('never surfaces an app from a failed show call', () => {
    const out = deriveOutputs([
      part('show', { url: 'http://localhost:3000' }, { status: 'error' }),
    ]);
    expect(out).toEqual([]);
  });

  it('ignores a show call with no URL — that is a file, not an app', () => {
    const out = deriveOutputs([part('show', { path: '/workspace/report.md' })]);
    expect(out.every((o) => o.kind !== 'app')).toBe(true);
  });

  it('ignores a non-http URL', () => {
    const out = deriveOutputs([part('show', { url: 'javascript:alert(1)' })]);
    expect(out.every((o) => o.kind !== 'app')).toBe(true);
  });
});

describe('deriveOutputs — files the agent SHOWED you', () => {
  it('surfaces a shown spreadsheet — the deliverable, not a write call', () => {
    const out = deriveOutputs([part('show', { path: '/workspace/report.xlsx' })]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('report.xlsx');
    expect(out[0].path).toBe('/workspace/report.xlsx');
    expect(out[0].kind).toBe('file');
  });

  it('surfaces a shown PDF and a shown CSV', () => {
    const out = deriveOutputs([
      part('show', { path: '/workspace/q3.pdf' }),
      part('show', { path: '/workspace/data.csv' }),
    ]);
    expect(out.map((o) => o.name)).toEqual(['q3.pdf', 'data.csv']);
  });

  it('reads the kind off the extension so the right renderer opens', () => {
    const out = deriveOutputs([
      part('show', { path: '/workspace/chart.png' }),
      part('show', { path: '/workspace/demo.mp4' }),
      part('show', { path: '/workspace/deck.pptx' }),
    ]);
    expect(out.map((o) => o.kind)).toEqual(['image', 'video', 'presentation']);
  });

  it('does not duplicate a file that was written and then shown', () => {
    const out = deriveOutputs([
      part('write', { filePath: '/workspace/report.md' }),
      part('show', { path: '/workspace/report.md' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('never surfaces a file from a failed show', () => {
    const out = deriveOutputs([
      part('show', { path: '/workspace/report.xlsx' }, { status: 'error' }),
    ]);
    expect(out).toEqual([]);
  });

  it('a show with a URL is an app, not a file', () => {
    const out = deriveOutputs([part('show', { url: 'http://localhost:3000' })]);
    expect(out[0].kind).toBe('app');
  });
});

describe('deriveOutputs — a show that hands over MANY things at once', () => {
  it('surfaces every file in a multi-item show (the carousel case)', () => {
    // Exactly the payload behind "All 5 files generated" — one show, five items,
    // no top-level path. This produced ZERO Outputs rows before.
    const out = deriveOutputs([
      part('show', {
        items: [
          { type: 'csv', path: '/tmp/jay-files/jay_suthar_profile.csv' },
          { type: 'xlsx', path: '/tmp/jay-files/jay_suthar_profile.xlsx' },
          { type: 'docx', path: '/tmp/jay-files/jay_suthar_profile.docx' },
          { type: 'pptx', path: '/tmp/jay-files/jay_suthar_profile.pptx' },
          { type: 'pdf', path: '/tmp/jay-files/jay_suthar_profile.pdf' },
        ],
      }),
    ]);

    expect(out.map((o) => o.name)).toEqual([
      'jay_suthar_profile.csv',
      'jay_suthar_profile.xlsx',
      'jay_suthar_profile.docx',
      'jay_suthar_profile.pptx',
      'jay_suthar_profile.pdf',
    ]);
    // The deck gets its own kind so it opens in the slides renderer.
    expect(out.map((o) => o.kind)).toEqual(['file', 'file', 'file', 'presentation', 'file']);
  });

  it('handles a carousel mixing a running app and files', () => {
    const out = deriveOutputs([
      part('show', {
        items: [
          { type: 'url', url: 'http://localhost:3000', title: 'Live Site' },
          { type: 'csv', path: '/tmp/data.csv' },
        ],
      }),
    ]);
    expect(out.map((o) => o.kind)).toEqual(['app', 'file']);
    expect(out[0].name).toBe('Live Site');
  });

  it('skips carousel items with nothing to open (inline text, errors)', () => {
    const out = deriveOutputs([
      part('show', {
        items: [
          { type: 'text', content: 'here is a summary' },
          { type: 'csv', path: '/tmp/data.csv' },
        ],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('data.csv');
  });

  it('does not double-count a file shown in a carousel and written earlier', () => {
    const out = deriveOutputs([
      part('write', { filePath: '/tmp/report.md' }),
      part('show', { items: [{ type: 'file', path: '/tmp/report.md' }] }),
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('deriveOutputs — a show whose items arrive as a JSON STRING', () => {
  // The real payload shape. `ShowTool` itself does
  //   typeof raw === 'string' ? JSON.parse(raw) : raw
  // because the model serializes `items` as a string. Anything that only checks
  // Array.isArray silently sees nothing — which is exactly why five generated
  // files rendered fine in the chat and appeared NOWHERE in Outputs.
  it('parses stringified items and surfaces every file', () => {
    const out = deriveOutputs([
      part('show', {
        items: JSON.stringify([
          { type: 'csv', path: '/tmp/jay-files/jay_suthar_profile.csv' },
          { type: 'xlsx', path: '/tmp/jay-files/jay_suthar_profile.xlsx' },
          { type: 'docx', path: '/tmp/jay-files/jay_suthar_profile.docx' },
          { type: 'pptx', path: '/tmp/jay-files/jay_suthar_profile.pptx' },
          { type: 'pdf', path: '/tmp/jay-files/jay_suthar_profile.pdf' },
        ]),
      }),
    ]);
    expect(out.map((o) => o.name)).toEqual([
      'jay_suthar_profile.csv',
      'jay_suthar_profile.xlsx',
      'jay_suthar_profile.docx',
      'jay_suthar_profile.pptx',
      'jay_suthar_profile.pdf',
    ]);
  });

  it('survives malformed JSON without throwing', () => {
    const out = deriveOutputs([part('show', { items: '[{"path": "/tmp/broken.csv"' })]);
    expect(out).toEqual([]);
  });
});

function partOf(tool: string, callID: string, input: Record<string, unknown>): ToolPart {
  return { type: 'tool', tool, callID, state: { status: 'completed', input } } as unknown as ToolPart;
}

describe('deriveOutputs — titles (W3)', () => {
  it('a shown file keeps its human title and description', () => {
    const parts = [
      partOf('show', 'c1', {
        path: '/workspace/quarterly_report_v2.pdf',
        title: 'Quarterly report',
        description: 'Q2 numbers',
      }),
    ];
    const [item] = deriveOutputs(parts);
    expect(item.name).toBe('quarterly_report_v2.pdf');
    expect(item.title).toBe('Quarterly report');
    expect(item.description).toBe('Q2 numbers');
  });
});

describe('deriveOutputs — last-write-wins + normalized keys (W11)', () => {
  it('re-writing the same path replaces the row and keeps ONE item, keyed to the later call', () => {
    const parts = [
      partOf('write', 'c1', { filePath: 'report.md' }),
      partOf('write', 'c2', { filePath: 'report.md' }),
    ];
    const items = deriveOutputs(parts);
    expect(items).toHaveLength(1);
    expect(items[0].callID).toBe('c2');
  });

  it('an absolute write and a workspace-relative re-write of the same file collapse to one row', () => {
    const parts = [
      partOf('write', 'c1', { filePath: '/workspace/report.md' }),
      partOf('write', 'c2', { filePath: 'report.md' }),
    ];
    expect(deriveOutputs(parts)).toHaveLength(1);
  });
});

describe('deriveOutputs — freshness (W11)', () => {
  it('latest-run items are new; re-produced paths are updated; older items are unmarked', () => {
    const parts = [
      partOf('write', 'old1', { filePath: 'a.md' }),
      partOf('write', 'old2', { filePath: 'b.md' }),
      partOf('write', 'new1', { filePath: 'b.md' }),
      partOf('write', 'new2', { filePath: 'c.md' }),
    ];
    const items = deriveOutputs(parts, { latestRun: new Set(['new1', 'new2']) });
    const byName = Object.fromEntries(items.map((i) => [i.name, i.fresh]));
    expect(byName['a.md']).toBeUndefined();
    expect(byName['b.md']).toBe('updated');
    expect(byName['c.md']).toBe('new');
  });
});
