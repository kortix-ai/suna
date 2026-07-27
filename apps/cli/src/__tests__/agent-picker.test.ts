import { describe, expect, test } from 'bun:test';

import {
  agentPickerItems,
  offerableAgents,
  pickerTitle,
  preselectedIndex,
  runAgentPicker,
  type AgentPickerContext,
  type AgentPickerDeps,
  type AgentPickerSelectOpts,
  type PickableAgent,
} from '../agent-picker.ts';

const AGI: PickableAgent = {
  name: 'kortix-agi',
  description:
    'Kortix AGI — the control agent that runs above your workspaces. Configures Kortix, runs the goal/task loop, and gets work done by spawning sessions rather than doing the work itself.',
  mode: 'primary',
  enabled: true,
  platform_owned: true,
};

// Byte-identical to what the API serves for a workspace agent: `platform_owned`
// is ABSENT, not false.
const WORKSPACE: PickableAgent = {
  name: 'kortix',
  description: 'Generic Kortix general knowledge worker.',
  mode: 'primary',
  enabled: true,
};

interface Recorder {
  deps: AgentPickerDeps;
  selects: AgentPickerSelectOpts[];
  started: string[];
  output: string;
}

function recorder(overrides: {
  interactive?: boolean;
  context?: AgentPickerContext | null;
  choose?: (opts: AgentPickerSelectOpts) => string | null;
  exitCode?: number;
}): Recorder {
  const rec: Recorder = {
    selects: [],
    started: [],
    output: '',
    deps: {
      isInteractive: () => overrides.interactive ?? true,
      loadContext: async () =>
        overrides.context === undefined
          ? { projectName: 'yo', agents: [AGI, WORKSPACE] }
          : overrides.context,
      select: async (opts) => {
        rec.selects.push(opts);
        if (overrides.choose) return overrides.choose(opts);
        return opts.items[opts.initialIndex]?.value ?? null;
      },
      startSession: async (name) => {
        rec.started.push(name);
        return overrides.exitCode ?? 0;
      },
      write: (text) => {
        rec.output += text;
      },
    },
  };
  return rec;
}

describe('offerableAgents', () => {
  test('puts platform-owned agents first no matter what order the API sent', () => {
    expect(offerableAgents([WORKSPACE, AGI]).map((a) => a.name)).toEqual(['kortix-agi', 'kortix']);
  });

  test('drops subagents and explicitly disabled agents', () => {
    const agents = offerableAgents([
      AGI,
      WORKSPACE,
      { name: 'helper', mode: 'subagent', enabled: true },
      { name: 'retired', mode: 'primary', enabled: false },
    ]);

    expect(agents.map((a) => a.name)).toEqual(['kortix-agi', 'kortix']);
  });

  test('an agent with no mode/enabled opinion stays offerable', () => {
    expect(offerableAgents([{ name: 'bare' }]).map((a) => a.name)).toEqual(['bare']);
  });

  test('elevation reads platform_owned === true, never the name or the source', () => {
    // A workspace agent that merely *claims* the platform source, and a
    // reserved-looking name with no marker — neither may be elevated.
    const agents = offerableAgents([
      { name: 'first', mode: 'primary' },
      { name: 'kortix-agi-lookalike', mode: 'primary' },
      { name: 'impostor', mode: 'primary', platform_owned: undefined },
    ]);

    expect(agents.map((a) => a.name)).toEqual(['first', 'kortix-agi-lookalike', 'impostor']);
  });
});

describe('preselectedIndex', () => {
  test('points at the platform-owned agent', () => {
    expect(preselectedIndex(offerableAgents([WORKSPACE, AGI]))).toBe(0);
  });

  test('is driven by platform_owned, not by list position', () => {
    // A hypothetical re-sort that pushes the AGI off the front (the SDK's
    // `projectConfigAgentsToOpenCodeAgents` does exactly that on the web) must
    // still preselect it.
    expect(preselectedIndex([WORKSPACE, AGI])).toBe(1);
  });

  test('falls back to the first row when the agi flag is off', () => {
    expect(preselectedIndex([WORKSPACE, { name: 'memory-reflector' }])).toBe(0);
  });
});

describe('agentPickerItems', () => {
  test('marks the platform-owned agent and column-aligns the rest', () => {
    const items = agentPickerItems(offerableAgents([WORKSPACE, AGI]));

    expect(items[0]!.label).toBe('★ kortix-agi');
    expect(items[0]!.value).toBe('kortix-agi');
    expect(items[1]!.label).toBe('  kortix');
    // Both markers are one column wide, so the names stay in one column.
    expect(items.every((i) => i.label.indexOf(i.value) === 2)).toBe(true);
  });

  test('no row is marked when the agi flag is off', () => {
    const items = agentPickerItems(offerableAgents([WORKSPACE]));

    expect(items.every((i) => !i.label.includes('★'))).toBe(true);
  });

  test('collapses and truncates the description so a long one cannot wrap the frame', () => {
    const items = agentPickerItems([AGI]);

    expect(items[0]!.sublabel!.length).toBeLessThanOrEqual(72);
    expect(items[0]!.sublabel).toContain('Kortix AGI');
    expect(items[0]!.sublabel).not.toContain('\n');
  });

  test('an agent with no description gets no sublabel', () => {
    expect(agentPickerItems([{ name: 'bare' }])[0]!.sublabel).toBeUndefined();
  });
});

describe('pickerTitle', () => {
  test('names the project when the detail call returned one', () => {
    expect(pickerTitle('yo')).toBe('Start a session in yo — pick an agent');
  });

  test('degrades without a project name', () => {
    expect(pickerTitle(null)).toBe('Start a session — pick an agent');
  });
});

describe('runAgentPicker', () => {
  test('a TTY picks the preselected AGI and starts a session with it', async () => {
    const rec = recorder({});

    const outcome = await runAgentPicker(rec.deps);

    expect(rec.selects[0]!.title).toBe('Start a session in yo — pick an agent');
    expect(rec.selects[0]!.items.map((i) => i.value)).toEqual(['kortix-agi', 'kortix']);
    expect(rec.selects[0]!.initialIndex).toBe(0);
    expect(rec.started).toEqual(['kortix-agi']);
    expect(outcome).toBe(0);
  });

  test('the session command exit code is propagated', async () => {
    const rec = recorder({ exitCode: 1 });

    expect(await runAgentPicker(rec.deps)).toBe(1);
  });

  test('arrowing to a workspace agent starts that one instead', async () => {
    const rec = recorder({ choose: (opts) => opts.items[1]!.value });

    const outcome = await runAgentPicker(rec.deps);

    expect(rec.started).toEqual(['kortix']);
    expect(outcome).toBe(0);
  });

  // The load-bearing one: agents and CI run bare `kortix`, and a blocking
  // prompt would wedge them forever.
  test('a non-TTY never prompts, never calls the API, and asks for the banner', async () => {
    const rec = recorder({ interactive: false });

    const outcome = await runAgentPicker(rec.deps);

    expect(outcome).toBe('banner');
    expect(rec.selects).toEqual([]);
    expect(rec.started).toEqual([]);
  });

  test('no login / no linked project / unreachable API all degrade to the banner', async () => {
    const rec = recorder({ context: null });

    expect(await runAgentPicker(rec.deps)).toBe('banner');
    expect(rec.selects).toEqual([]);
  });

  test('an empty roster shows the banner rather than an empty picker', async () => {
    // What a caller without project.agent.read sees: the array blanks to [].
    const rec = recorder({ context: { projectName: 'yo', agents: [] } });

    expect(await runAgentPicker(rec.deps)).toBe('banner');
    expect(rec.selects).toEqual([]);
  });

  test('a roster of only subagents is empty after filtering, so it shows the banner', async () => {
    const rec = recorder({
      context: { projectName: 'yo', agents: [{ name: 'helper', mode: 'subagent' }] },
    });

    expect(await runAgentPicker(rec.deps)).toBe('banner');
    expect(rec.selects).toEqual([]);
  });

  test('with the agi flag off the picker still works, just without an elevated row', async () => {
    const rec = recorder({
      context: { projectName: 'yo', agents: [WORKSPACE, { name: 'memory-reflector' }] },
    });

    const outcome = await runAgentPicker(rec.deps);

    expect(rec.selects[0]!.items.map((i) => i.label)).toEqual(['  kortix', '  memory-reflector']);
    expect(rec.selects[0]!.initialIndex).toBe(0);
    expect(rec.started).toEqual(['kortix']);
    expect(outcome).toBe(0);
  });

  test('cancelling exits cleanly without starting anything', async () => {
    const rec = recorder({ choose: () => null });

    const outcome = await runAgentPicker(rec.deps);

    expect(outcome).toBe(0);
    expect(rec.started).toEqual([]);
    expect(rec.output).toContain('Nothing started');
  });

  test('the chosen agent is echoed, since the picker wipes its own frame', async () => {
    const rec = recorder({});

    await runAgentPicker(rec.deps);

    expect(rec.output).toContain('kortix-agi');
  });
});
