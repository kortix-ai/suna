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

  it('names every distinct tool in a group instead of only parts[0]', () => {
    const line = narrateStep('other', [part('linear/create_issue'), part('slack/send')]);
    expect(line).toBe('Used Create Issue and Send');
  });

  it('is count-aware when the same unrecognized tool is called more than once', () => {
    const line = narrateStep('other', [part('linear/create_issue'), part('linear/create_issue')]);
    expect(line).toBe('Used Create Issue · 2 times');
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

// ─── action-multiplexed tools: a single tool name dispatches on `input.action`
// (or `input.command`) across genuinely different operations. Narration must
// never fold a destructive or read-only action into a creation/mutation
// sentence just because the tool name looks generative. ────────────────────

describe('narrateStep - presentation_gen must resolve its own action, not always "Built a presentation"', () => {
  it('never narrates delete_presentation as a creation', () => {
    const line = narrateStep('create', [
      part('presentation_gen', { action: 'delete_presentation', presentation_name: 'demo' }),
    ]);
    expect(line.toLowerCase()).not.toContain('built');
    expect(line.toLowerCase()).not.toContain('made');
    expect(line.toLowerCase()).toContain('delet');
  });

  it('never narrates delete_slide as a creation', () => {
    const line = narrateStep('create', [part('presentation_gen', { action: 'delete_slide' })]);
    expect(line.toLowerCase()).not.toContain('built');
    expect(line.toLowerCase()).toContain('delet');
  });

  it('never narrates list_presentations (read-only) as a mutation', () => {
    const line = narrateStep('create', [part('presentation_gen', { action: 'list_presentations' })]);
    expect(line.toLowerCase()).not.toContain('built');
    expect(line.toLowerCase()).not.toContain('made');
    expect(line.toLowerCase()).not.toContain('delet');
  });

  it('never narrates list_slides (read-only) as a mutation', () => {
    const line = narrateStep('create', [part('presentation_gen', { action: 'list_slides' })]);
    expect(line.toLowerCase()).not.toContain('built');
    expect(line.toLowerCase()).not.toContain('made');
  });

  it('never narrates validate_slide (read-only check) as a mutation', () => {
    const line = narrateStep('create', [part('presentation_gen', { action: 'validate_slide' })]);
    expect(line.toLowerCase()).not.toContain('built');
    expect(line.toLowerCase()).not.toContain('made');
  });

  it('never narrates export_pdf/export_pptx/preview/serve as a creation', () => {
    for (const action of ['export_pdf', 'export_pptx', 'preview', 'serve']) {
      const line = narrateStep('create', [part('presentation_gen', { action })]);
      expect(line.toLowerCase()).not.toContain('built');
      expect(line.toLowerCase()).not.toContain('made');
    }
  });

  it('still narrates create_slide as making progress on a presentation', () => {
    const line = narrateStep('create', [part('presentation_gen', { action: 'create_slide' })]);
    expect(line.toLowerCase()).not.toContain('delet');
  });

  it('falls back to a vague-but-true sentence when action is missing/unrecognized (singular)', () => {
    expect(narrateStep('create', [part('presentation_gen', {})])).toBe('Worked on a presentation');
  });

  it('falls back to a vague-but-true sentence when action is unrecognized (singular)', () => {
    expect(narrateStep('create', [part('presentation_gen', { action: 'some_future_action' })])).toBe(
      'Worked on a presentation',
    );
  });

  it('falls back to a vague-but-true sentence when action is missing/unrecognized (grouped)', () => {
    const line = narrateStep('create', [
      part('presentation_gen', {}),
      part('presentation_gen', {}),
    ]);
    expect(line).toBe('Worked on 2 presentations');
  });
});

describe('narrateStep - image_gen must resolve its own action, not always "Made an image"', () => {
  it('never narrates edit as a fresh creation', () => {
    const line = narrateStep('create', [part('image_gen', { action: 'edit' })]);
    expect(line).not.toBe('Made an image');
    expect(line.toLowerCase()).not.toContain('made');
  });

  it('never narrates upscale as a fresh creation', () => {
    const line = narrateStep('create', [part('image_gen', { action: 'upscale' })]);
    expect(line.toLowerCase()).not.toContain('made');
  });

  it('never narrates remove_bg as a fresh creation', () => {
    const line = narrateStep('create', [part('image_gen', { action: 'remove_bg' })]);
    expect(line.toLowerCase()).not.toContain('made');
  });

  it('still narrates generate as making an image', () => {
    const line = narrateStep('create', [part('image_gen', { action: 'generate' })]);
    expect(line.toLowerCase()).toContain('made');
  });

  it('falls back to a vague-but-true sentence when action is missing (singular)', () => {
    expect(narrateStep('create', [part('image_gen', {})])).toBe('Worked on an image');
  });

  it('falls back to a vague-but-true sentence when action is missing (grouped)', () => {
    const line = narrateStep('create', [part('image_gen', {}), part('image_gen', {})]);
    expect(line).toBe('Worked on 2 images');
  });

  it('a mixed group of a real creation and an edit never claims "Made" or "showed"', () => {
    const line = narrateStep('create', [
      part('image_gen', { action: 'generate' }),
      part('image_gen', { action: 'edit' }),
    ]);
    expect(line).toBe('Worked on 2 images');
  });

  it('does not narrate a grouped create_slide + delete_presentation as "Made 2 presentations"', () => {
    const line = narrateStep('create', [
      part('presentation_gen', { action: 'create_slide' }),
      part('presentation_gen', { action: 'delete_presentation' }),
    ]);
    expect(line).toBe('Worked on 2 presentations');
  });
});

describe('narrateStep - create family grouped (n > 1) must resolve each part\'s own action, not bucket everything non-creation into "shown"', () => {
  it('narrates 2x delete_presentation as a deletion, not a display', () => {
    const line = narrateStep('create', [
      part('presentation_gen', { action: 'delete_presentation' }),
      part('presentation_gen', { action: 'delete_presentation' }),
    ]);
    expect(line).toBe('Deleted 2 presentations');
  });

  it('narrates 2x delete_slide as a deletion, not a display', () => {
    const line = narrateStep('create', [
      part('presentation_gen', { action: 'delete_slide' }),
      part('presentation_gen', { action: 'delete_slide' }),
    ]);
    expect(line).toBe('Deleted 2 slides');
  });

  it('narrates 2x image edit as an edit, not a display', () => {
    const line = narrateStep('create', [
      part('image_gen', { action: 'edit' }),
      part('image_gen', { action: 'edit' }),
    ]);
    expect(line).toBe('Edited 2 images');
  });

  it('narrates 2x export_pdf as an export, not a display', () => {
    const line = narrateStep('create', [
      part('presentation_gen', { action: 'export_pdf' }),
      part('presentation_gen', { action: 'export_pdf' }),
    ]);
    expect(line).toBe('Exported 2 presentations to PDF');
  });

  it('narrates 2x list_presentations as a read, not a display', () => {
    const line = narrateStep('create', [
      part('presentation_gen', { action: 'list_presentations' }),
      part('presentation_gen', { action: 'list_presentations' }),
    ]);
    expect(line).toBe('Checked your presentations');
  });

  it('narrates 2x create_slide without claiming 2 presentations were made', () => {
    const line = narrateStep('create', [
      part('presentation_gen', { action: 'create_slide' }),
      part('presentation_gen', { action: 'create_slide' }),
    ]);
    expect(line).toBe('Added 2 slides');
    expect(line).not.toContain('Made 2 presentations');
  });
});

describe('narrateStep - project_update is a real mutation, not "Opened your project"', () => {
  it('does not say "Opened" for project_update', () => {
    const line = narrateStep('projects', [part('project_update', { project: 'demo' })]);
    expect(line).not.toContain('Opened');
  });

  it('says the project was updated', () => {
    const line = narrateStep('projects', [part('project_update', { project: 'demo' })]);
    expect(line.toLowerCase()).toContain('updat');
  });
});

describe('narrateStep - trigger_test is a dry run, not a mutation', () => {
  it('does not say "Adjusted" for trigger_test', () => {
    const line = narrateStep('automations', [part('trigger_test')]);
    expect(line.toLowerCase()).not.toContain('adjusted');
  });

  it('still says "Adjusted" for pause/resume (genuine control actions)', () => {
    expect(narrateStep('automations', [part('trigger_pause')]).toLowerCase()).toContain('adjusted');
    expect(narrateStep('automations', [part('trigger_resume')]).toLowerCase()).toContain('adjusted');
  });
});

describe('narrateStep - automations must not guess a read for an unrecognized action', () => {
  it('never narrates an unrecognized bare-"triggers" action as a read ("Checked...")', () => {
    // TriggersTool's own default branch (triggers-tool.tsx) renders a generic
    // "Triggers" title, NOT the "List Triggers" branch — narration must not
    // pretend to know it's a read when the tool itself doesn't.
    const line = narrateStep('automations', [part('triggers', { action: 'disable' })]);
    expect(line).toBe('Worked with your automations');
  });

  it('still defaults an absent action to a read (matches TriggersTool:199)', () => {
    const line = narrateStep('automations', [part('triggers', {})]);
    expect(line).toBe('Checked your automations');
  });
});

describe('narrateStep - projects/skills are count-aware, not just parts[0]', () => {
  it('reports the count for multiple created projects instead of only naming the first', () => {
    const line = narrateStep('projects', [
      part('project_create', { project: 'alpha' }),
      part('project_create', { project: 'beta' }),
    ]);
    expect(line).toContain('2 projects');
  });

  it('reports the count for multiple skills instead of only naming the first', () => {
    const line = narrateStep('skills', [part('skill', { name: 'alpha' }), part('skill', { name: 'beta' })]);
    expect(line).toContain('2 skills');
  });

  it('still names a single skill', () => {
    const line = narrateStep('skills', [part('skill', { name: 'writing' })]);
    expect(line).toContain('writing');
  });
});

describe('narrateStep - the bare "memory" tool multiplexes over `command`, not always a recall', () => {
  it('never narrates memory delete as a mere recall', () => {
    const line = narrateStep('memory', [part('memory', { command: 'delete', path: '/mem/x.md' })]);
    expect(line.toLowerCase()).not.toContain('recalled');
    expect(line.toLowerCase()).toContain('delet');
  });

  it('never narrates memory create (a write) as a mere recall', () => {
    const line = narrateStep('memory', [part('memory', { command: 'create', path: '/mem/x.md' })]);
    expect(line.toLowerCase()).not.toContain('recalled');
  });

  it('never narrates memory str_replace/insert/rename (edits) as a mere recall', () => {
    for (const command of ['str_replace', 'insert', 'rename']) {
      const line = narrateStep('memory', [part('memory', { command })]);
      expect(line.toLowerCase()).not.toContain('recalled');
    }
  });

  it('still narrates memory view as a recall', () => {
    const line = narrateStep('memory', [part('memory', { command: 'view' })]);
    expect(line.toLowerCase()).toContain('recalled');
  });

  it('still narrates memory_search/mem_search/ltm_search/get_mem as a recall', () => {
    for (const t of ['memory_search', 'mem_search', 'ltm_search', 'get_mem']) {
      expect(narrateStep('memory', [part(t)]).toLowerCase()).toContain('recalled');
    }
  });
});

// ─── show/show_user must never leak a raw sandbox path or URL — rule 2 is
// that a raw tool identifier, path, or URL must never reach a non-technical
// user. `show`/`show_user` have no case in `getToolPrimaryArg`, so narration
// used to fall through to the generic input-key fallback (path/url, verbatim,
// no basename/domain treatment) — the exact opposite of every other family's
// treatment of paths and URLs in this file. ─────────────────────────────────
describe('narrateStep - show/show_user never leak a raw path or URL', () => {
  it('prefers the tool input title over anything else', () => {
    const line = narrateStep('create', [
      part('show', {
        title: 'Q3 report',
        path: '/workspace/reports/q3.html',
        url: 'https://8080-abc123.e2b.app/preview',
      }),
    ]);
    expect(line).toBe('Showed you Q3 report');
  });

  it('falls back to description when there is no title', () => {
    const line = narrateStep('create', [
      part('show', { description: 'The finished report', path: '/workspace/reports/q3.html' }),
    ]);
    expect(line).toBe('Showed you The finished report');
  });

  it('never renders a raw sandbox path — falls back to a basename', () => {
    const line = narrateStep('create', [part('show', { path: '/workspace/reports/q3.html' })]);
    expect(line).toBe('Showed you q3.html');
    expect(line).not.toContain('/workspace');
  });

  it('never renders a raw URL — falls back to a domain', () => {
    const line = narrateStep('create', [
      part('show', { type: 'url', url: 'https://8080-abc123.e2b.app/preview' }),
    ]);
    expect(line).not.toContain('https://');
    expect(line).not.toContain('/preview');
    expect(line).toBe('Showed you 8080-abc123.e2b.app');
  });

  it('falls back to the vague-but-true default when nothing at all is available', () => {
    const line = narrateStep('create', [part('show', {})]);
    expect(line).toBe('Showed you the result');
  });

  it('show_user is treated identically to show', () => {
    const line = narrateStep('create', [part('show_user', { path: '/a/b/c/report.pdf' })]);
    expect(line).toBe('Showed you report.pdf');
  });
});

describe('humanizeToolName - MCP tools using `__` separators must not read as a raw identifier', () => {
  it('normalizes `__` the same way `/` is normalized', () => {
    expect(humanizeToolName('mcp__linear__create_issue')).toBe('Create Issue');
  });

  it('never leaves double spaces or underscores from an un-normalized `__`', () => {
    const label = humanizeToolName('mcp__linear__create_issue');
    expect(label).not.toContain('  ');
    expect(label).not.toContain('_');
  });
});

describe('narrateStep - task_update/agent_task_update resolve their own action field', () => {
  it('never narrates a cancel-via-update as sending a message', () => {
    const line = narrateStep('delegate', [part('task_update', { action: 'cancel' })]);
    expect(line.toLowerCase()).not.toContain('sent instructions');
    expect(line.toLowerCase()).toContain('stopped');
  });

  it('never narrates an approve-via-update as sending a message', () => {
    const line = narrateStep('delegate', [part('agent_task_update', { action: 'approve' })]);
    expect(line.toLowerCase()).not.toContain('sent instructions');
  });

  it('never narrates a start-via-update as sending a message', () => {
    const line = narrateStep('delegate', [part('task_update', { action: 'start' })]);
    expect(line.toLowerCase()).not.toContain('sent instructions');
  });

  it('falls back to a message narration when action is absent (component default)', () => {
    const line = narrateStep('delegate', [part('task_update', {})]);
    expect(line.toLowerCase()).toContain('instructions');
  });
});
