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

describe('familyForTool - identical components must share a family', () => {
  it('resolves task_create and agent_task_create to the same family (both render AgentSpawnTool)', () => {
    expect(familyForTool('task_create')).toBe(familyForTool('agent_task_create'));
    expect(familyForTool('task_create')).toBe('delegate');
  });

  it('resolves task_start and agent_task_start to the same family', () => {
    expect(familyForTool('task_start')).toBe(familyForTool('agent_task_start'));
  });

  it('resolves task_update and agent_task_update to the same family (both render AgentTaskUpdateTool)', () => {
    expect(familyForTool('task_update')).toBe(familyForTool('agent_task_update'));
  });

  it('resolves task_message and agent_task_message to the same family (both render AgentMessageTool)', () => {
    expect(familyForTool('task_message')).toBe(familyForTool('agent_task_message'));
  });

  it('resolves task_approve, agent_task_approve and task_done to the same family (all render TaskDoneTool)', () => {
    const f = familyForTool('task_done');
    expect(familyForTool('task_approve')).toBe(f);
    expect(familyForTool('agent_task_approve')).toBe(f);
  });

  it('resolves task_cancel and agent_task_cancel to the same family (both render AgentStopTool)', () => {
    expect(familyForTool('task_cancel')).toBe(familyForTool('agent_task_cancel'));
  });

  it('resolves task_list, task_get and agent_task_get to the same family (all render TaskListTool)', () => {
    const f = familyForTool('task_list');
    expect(familyForTool('task_get')).toBe(f);
    expect(familyForTool('agent_task_get')).toBe(f);
  });
});

describe('familyForTool - session_spawn/session_start_background/session_message are delegation, not history', () => {
  it('maps session_spawn and session_start_background to delegate', () => {
    expect(familyForTool('session_spawn')).toBe('delegate');
    expect(familyForTool('session_start_background')).toBe('delegate');
  });

  it('maps session_message to delegate', () => {
    expect(familyForTool('session_message')).toBe('delegate');
  });

  it('keeps genuine history lookups in sessions', () => {
    for (const t of [
      'session_get',
      'session_read',
      'session_search',
      'session_lineage',
      'session_stats',
      'session_list',
      'session_list_background',
      'session_list_spawned',
    ]) {
      expect(familyForTool(t)).toBe('sessions');
    }
  });
});

describe('narrateStep - identical components narrate identically regardless of alias', () => {
  it('task_create and agent_task_create produce the exact same sentence', () => {
    const a = narrateStep('delegate', [part('task_create')]);
    const b = narrateStep('delegate', [part('agent_task_create')]);
    expect(a).toBe(b);
  });

  it('task_cancel and agent_task_cancel produce the exact same sentence', () => {
    const a = narrateStep('delegate', [part('task_cancel')]);
    const b = narrateStep('delegate', [part('agent_task_cancel')]);
    expect(a).toBe(b);
  });

  it('is grammatical for a single spawn and for multiple spawns', () => {
    expect(narrateStep('delegate', [part('agent_spawn')])).not.toMatch(/\b1\b/);
    const many = narrateStep('delegate', [part('agent_spawn'), part('agent_spawn')]);
    expect(many).toContain('2');
    expect(many).not.toContain('2 helper agent ');
  });
});

describe('narrateStep - automations must distinguish create/update from read from delete', () => {
  it('never narrates trigger_delete as setting up an automation', () => {
    const line = narrateStep('automations', [part('trigger_delete')]);
    expect(line.toLowerCase()).not.toContain('set up');
  });

  it('never narrates trigger_list as setting up an automation', () => {
    const line = narrateStep('automations', [part('trigger_list')]);
    expect(line.toLowerCase()).not.toContain('set up');
  });

  it('never narrates trigger_get as setting up an automation', () => {
    const line = narrateStep('automations', [part('trigger_get')]);
    expect(line.toLowerCase()).not.toContain('set up');
  });

  it('the bare "triggers" tool defaults to a read narration when its action input is omitted', () => {
    const line = narrateStep('automations', [part('triggers', {})]);
    expect(line.toLowerCase()).not.toContain('set up');
  });

  it('still narrates trigger_create as setting up an automation', () => {
    const line = narrateStep('automations', [part('trigger_create')]);
    expect(line.toLowerCase()).toContain('set up');
  });

  it('is grammatical for one deleted automation and for several', () => {
    expect(narrateStep('automations', [part('trigger_delete')])).not.toMatch(/1 automations/);
    expect(narrateStep('automations', [part('trigger_delete'), part('trigger_delete')])).toContain(
      '2 automations',
    );
  });
});

describe('narrateStep - project_delete must never claim to have opened anything', () => {
  it('does not say "Opened" for project_delete', () => {
    const line = narrateStep('projects', [part('project_delete', { project: 'demo' })]);
    expect(line).not.toContain('Opened');
  });

  it('still says "Opened" for project_get/project_list/project_select', () => {
    for (const t of ['project_get', 'project_list', 'project_select']) {
      expect(narrateStep('projects', [part(t, { project: 'demo' })])).toContain('Opened');
    }
  });
});

describe('narrateStep - create family counts every media type in a mixed group', () => {
  it('reports images and videos separately instead of using only parts[0]', () => {
    const line = narrateStep('create', [part('image_gen'), part('image_gen'), part('video_gen')]);
    expect(line).toContain('2 images');
    expect(line).toContain('1 video');
  });

  it('reports all three media types when mixed', () => {
    const line = narrateStep('create', [
      part('image_gen'),
      part('video_gen'),
      part('presentation_gen'),
    ]);
    expect(line).toContain('image');
    expect(line).toContain('video');
    expect(line).toContain('presentation');
  });
});

describe('narrateStep - apps distinguishes discovery from connection', () => {
  it('never says "Connected to" for read-only discovery/description tools', () => {
    for (const t of [
      'kortix_executor_discover',
      'kortix_executor_describe',
      'kortix_executor_connectors',
      'connector_get',
      'connector_list',
    ]) {
      expect(narrateStep('apps', [part(t)])).not.toContain('Connected to');
    }
  });

  it('still says "Connected" for connector_setup', () => {
    expect(narrateStep('apps', [part('connector_setup')])).toContain('Connected');
  });

  it('distinguishes running a connected tool from connecting to it', () => {
    expect(narrateStep('apps', [part('kortix_executor_call')])).not.toContain('Connected to');
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
