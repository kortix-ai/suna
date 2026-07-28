import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The connector detail screen lives in one 5k-line file, so its contract with
 * this module is asserted against the source text — the house pattern for
 * screens too entangled with react-query to render in a unit test.
 *
 * These are anti-regression assertions above all: the simplification moved a
 * lot of behaviour, and every capability that moved has a test here saying it
 * still exists at its new address.
 */
const SOURCE = readFileSync(
  join(import.meta.dir, '..', 'customize', 'sections', 'connectors-view.tsx'),
  'utf8',
);

describe('the tools panel is the shared component', () => {
  test('connectors-view imports ConnectorTools from this module', () => {
    expect(SOURCE).toContain("from '@/features/workspace/connectors/connector-tools'");
    expect(SOURCE).toContain('ConnectorTools,');
  });

  test('it is actually rendered, not merely imported', () => {
    expect(SOURCE).toContain('<ConnectorTools');
  });

  test('the hand-rolled tool list is gone', () => {
    // The old list mapped a locally filtered array inside its own scroller.
    expect(SOURCE).not.toContain('max-h-[52vh]');
    expect(SOURCE).not.toContain('{filtered.map((t) => {');
  });

  test('the old duplicate tool search is gone — ConnectorTools owns search now', () => {
    expect(SOURCE).not.toContain('PlaceholderFiltere5f64efb');
  });
});

describe('nothing the old list could do was dropped', () => {
  test('per-tool policy changes still flow through setChoice', () => {
    expect(SOURCE).toContain('onChange={setChoice}');
  });

  test('one choice across many tools is wired to the group control', () => {
    expect(SOURCE).toContain('onChangeGroup={setChoices}');
  });

  test('hand-picked multi-select survived the move', () => {
    expect(SOURCE).toContain('ConnectorToolSelection');
    expect(SOURCE).toContain('selection={selection}');
    expect(SOURCE).toContain('onApply: (choice) => setChoices([...selected], choice)');
  });

  test('project-decided tools are still marked on the row', () => {
    expect(SOURCE).toContain('governedPaths={governedPathSet}');
    expect(SOURCE).toContain('renderToolBadge=');
    expect(SOURCE).toContain('by project');
  });

  test('a pattern rule governing a tool is still shown on that tool', () => {
    expect(SOURCE).toContain('From pattern rule:');
  });

  test('the developer detail — call signature and input schema — stays reachable', () => {
    expect(SOURCE).toContain('renderToolDetail=');
    expect(SOURCE).toContain('code={tsSignature(connector.slug, t)}');
    expect(SOURCE).toContain("t.inputSchema ?? { type: 'object', properties: {} }");
  });
});

describe('the warnings that make the panel truthful', () => {
  test('the project-wide-rule banner still fires', () => {
    expect(SOURCE).toContain('set by a project-wide rule');
  });

  test('the "applies to all N connections" banner still fires', () => {
    expect(SOURCE).toContain('Applies to all ${connectionCount} connections');
  });

  test('the sensitive default keeps both of its choices', () => {
    expect(SOURCE).toContain('value="follow_rules"');
    expect(SOURCE).toContain('value="ask_first"');
    expect(SOURCE).toContain('label="Ask first"');
  });
});

describe('pattern rules moved behind one Advanced disclosure', () => {
  test('the rules block is a Disclosure driven by showRules', () => {
    expect(SOURCE).toContain('open={showRules}');
    expect(SOURCE).toContain('onOpenChange={setShowRules}');
  });

  test('it is labelled Advanced', () => {
    expect(SOURCE).toMatch(/<DisclosureTrigger>[\s\S]{0,400}Advanced/);
  });

  test('the rules editor itself is untouched — add, edit, choose, delete', () => {
    expect(SOURCE).toContain("{ id: ruleId(), match: '', action: 'require_approval' }");
    expect(SOURCE).toContain('setRules((rs) => rs.filter((x) => x.id !== r.id))');
  });
});

describe('the save bar and dirty tracking still work exactly as before', () => {
  test('dirty is still the policy signature diffed against the server', () => {
    expect(SOURCE).toContain('const dirty = policiesSig(perTool, rules) !== serverSig;');
  });

  test('the save bar is still rendered from that signal', () => {
    expect(SOURCE).toContain('dirty={dirty}');
    expect(SOURCE).toContain('onSave={() => save.mutate()}');
    expect(SOURCE).toContain('onReset={reset}');
  });

  test('saving still writes per-tool policies AND pattern rules', () => {
    expect(SOURCE).toContain('setConnectorPolicies(projectId, connector.slug, policies)');
  });
});

describe('the detail is the two-column shape', () => {
  test('overview left, tools right, stacking below lg', () => {
    expect(SOURCE).toContain('lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]');
  });

  test('the overview column is the shared component fed real connector facts', () => {
    expect(SOURCE).toContain('<ConnectorOverview');
    expect(SOURCE).toContain('connectedAs={connectedAs}');
    expect(SOURCE).toContain('profileId={connectionProfile?.profile_id ?? null}');
    expect(SOURCE).toContain('onCopyProfileId={copyProfileId}');
  });

  test('the header carries one line of description', () => {
    expect(SOURCE).toContain('connectorHeadline(providerLabel(connector.provider), toolCount)');
  });

  test('renaming in place survived the header rewrite', () => {
    expect(SOURCE).toContain('aria-label="Rename"');
    expect(SOURCE).toContain('rename.mutate()');
  });

  test('the connect action is one button, not a header button plus a banner CTA', () => {
    const connects = SOURCE.match(/\{isPipedream \? 'Connect for the team' :/g) ?? [];
    expect(connects).toHaveLength(1);
  });
});

describe('every other tab is still reachable', () => {
  test('Overview is the landing tab', () => {
    expect(SOURCE).toContain('<TabsTrigger value="overview"');
    expect(SOURCE).toContain("useState('overview')");
  });

  test('Connections, Connection and Team members all survive', () => {
    expect(SOURCE).toContain('<TabsTrigger value="connections"');
    expect(SOURCE).toContain('<TabsTrigger value="profile"');
    expect(SOURCE).toContain('<TabsTrigger value="roster"');
  });

  test('the permissions panel can still send the reader to Connections', () => {
    expect(SOURCE).toContain("setDetailTab('connections')");
  });

  test('removing a connector is still offered', () => {
    expect(SOURCE).toContain('setConfirmDelete(true)');
  });
});
