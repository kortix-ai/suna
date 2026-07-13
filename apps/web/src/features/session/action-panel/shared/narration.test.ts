import { describe, expect, it } from 'bun:test';
import type { ToolPart } from '@/ui';
import { familyForTool, humanizeToolName, narrateStep } from './narration';
import { ToolRegistry } from '../../tool/tool-renderers';
import '../../tool/tools/register';

function part(tool: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    type: 'tool',
    tool,
    callID: `c-${tool}-${Math.random()}`,
    state: { status: 'completed', input },
  } as unknown as ToolPart;
}

describe('familyForTool', () => {
  it('maps the explore family', () => {
    for (const t of ['read', 'glob', 'grep', 'list']) {
      expect(familyForTool(t)).toBe('explore');
    }
  });

  it('maps the edit family', () => {
    for (const t of ['write', 'edit', 'morph_edit', 'apply_patch']) {
      expect(familyForTool(t)).toBe('edit');
    }
  });

  it('maps the web family', () => {
    for (const t of ['web_search', 'websearch', 'web_fetch', 'webfetch', 'scrape_webpage']) {
      expect(familyForTool(t)).toBe('web');
    }
  });

  it('hides context-engine bookkeeping', () => {
    for (const t of ['prune', 'distill', 'compress', 'context_info']) {
      expect(familyForTool(t)).toBe('hidden');
    }
  });

  it('normalizes oc- prefixes and kebab-case aliases', () => {
    expect(familyForTool('oc-session_read')).toBe('sessions');
    expect(familyForTool('session-read')).toBe('sessions');
    expect(familyForTool('oc-trigger-create')).toBe('automations');
  });

  it('falls back to "other" for MCP and unknown tools', () => {
    expect(familyForTool('linear/create_issue')).toBe('other');
    expect(familyForTool('some_tool_shipped_next_year')).toBe('other');
  });
});

describe('narrateStep', () => {
  it('names a single written file', () => {
    expect(narrateStep('edit', [part('write', { filePath: '/a/report.md' })])).toBe(
      'Wrote report.md',
    );
  });

  it('counts multiple edits', () => {
    expect(
      narrateStep('edit', [
        part('edit', { filePath: '/a/one.ts' }),
        part('edit', { filePath: '/a/two.ts' }),
      ]),
    ).toBe('Updated 2 files');
  });

  it('counts reads', () => {
    expect(narrateStep('explore', [part('read'), part('read'), part('read')])).toBe('Read 3 files');
  });

  it('counts web searches', () => {
    expect(narrateStep('web', [part('web_search'), part('web_search')])).toBe(
      'Searched the web · 2 queries',
    );
  });

  it('never emits a raw tool name for unknown tools', () => {
    const line = narrateStep('other', [part('linear/create_issue')]);
    expect(line).toBe('Used Create Issue');
    expect(line).not.toContain('_');
    expect(line).not.toContain('/');
  });
});

describe('humanizeToolName', () => {
  it('strips the MCP server prefix and title-cases', () => {
    expect(humanizeToolName('linear/create_issue')).toBe('Create Issue');
    expect(humanizeToolName('oc-session_read')).toBe('Session Read');
  });
});

describe('registry coverage', () => {
  it('every registered tool resolves to a family, hidden, or the fallback', () => {
    // ToolRegistry exposes its keys for this check — see Step 7.
    for (const key of ToolRegistry.keys()) {
      const family = familyForTool(key);
      expect(family).toBeTruthy();
      // 'other' is legal, but a *registered* tool landing there means the map
      // has fallen behind — surface it loudly.
      if (family === 'other') {
        throw new Error(`Registered tool "${key}" has no narration family — add it to narration.ts`);
      }
    }
  });
});
