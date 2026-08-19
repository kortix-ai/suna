import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildScopeChecklist,
  buildSecretScopeOptions,
  toggleScopeSelection,
} from './agent-detail-aside';

const secret = (identifier: string, name: string) => ({ identifier, name });

describe('buildSecretScopeOptions', () => {
  test('keys the checklist on IDENTIFIER, not on the env var name', () => {
    // `id` is what `setAgentScope` writes into the manifest grant, and every
    // consumer matches by identifier (`listAdmits` in the delivery rule,
    // `agentMayUseEnv` in the agent-scope gate). Writing the env var KEY
    // produced a grant nothing ever matched, so the secret was never delivered
    // and nothing said so.
    const options = buildSecretScopeOptions([secret('gmaps-primary', 'GOOGLE_MAPS_API_KEY')]);
    expect(options).toEqual([
      { id: 'gmaps-primary', label: 'gmaps-primary', hint: 'GOOGLE_MAPS_API_KEY' },
    ]);
  });

  test('two secrets sharing one env var name stay separately grantable', () => {
    // `name` is not unique. De-duplicating on it collapsed these into one row,
    // so the primary key could not be granted without the backup.
    const options = buildSecretScopeOptions([
      secret('gmaps-primary', 'GOOGLE_MAPS_API_KEY'),
      secret('gmaps-backup', 'GOOGLE_MAPS_API_KEY'),
    ]);
    expect(options.map((o) => o.id)).toEqual(['gmaps-backup', 'gmaps-primary']);
  });

  test('omits the hint when the name adds nothing', () => {
    const [option] = buildSecretScopeOptions([secret('OPENAI_API_KEY', 'OPENAI_API_KEY')]);
    expect(option.hint).toBeUndefined();
  });

  test('sorts by identifier', () => {
    const options = buildSecretScopeOptions([
      secret('zulu', 'Z'),
      secret('alpha', 'A'),
      secret('mike', 'M'),
    ]);
    expect(options.map((o) => o.id)).toEqual(['alpha', 'mike', 'zulu']);
  });

  test('the ids it emits round-trip through the read-only mirror', () => {
    // The mirror below the editor prints `scope.env` verbatim. When the editor
    // wrote names and the mirror printed identifiers, the two halves of one card
    // disagreed about the same secret.
    const options = buildSecretScopeOptions([secret('gmaps-primary', 'GOOGLE_MAPS_API_KEY')]);
    const committedGrant = options.map((o) => o.id);
    expect(committedGrant).toEqual(['gmaps-primary']);
  });
});

describe('buildScopeChecklist', () => {
  const secrets = buildSecretScopeOptions([secret('GMAPS-primary', 'GOOGLE_MAPS_API_KEY')]);

  test('ticks the row a lowercase kortix.yaml entry actually grants', () => {
    // `agentMayUseEnv` uppercases both sides, so the server DOES deliver this
    // secret. Matching exactly here showed the row unticked AND added a second
    // row flagged "missing" — the editor calling a working grant broken.
    const rows = buildScopeChecklist(['gmaps-primary'], secrets, 'case-insensitive');
    expect(rows).toEqual([
      {
        id: 'GMAPS-primary',
        label: 'GMAPS-primary',
        hint: 'GOOGLE_MAPS_API_KEY',
        selected: true,
        orphan: false,
      },
    ]);
  });

  test('connector slugs stay exact, matching agentMayUseConnector', () => {
    const rows = buildScopeChecklist(['GMAIL'], [{ id: 'gmail', label: 'Gmail' }]);
    expect(rows.map((r) => [r.id, r.selected, r.orphan])).toEqual([
      ['gmail', false, false],
      ['GMAIL', true, true],
    ]);
  });

  test('a genuinely deleted entry is still listed and flagged', () => {
    const rows = buildScopeChecklist(['deleted-secret'], secrets, 'case-insensitive');
    expect(rows.find((r) => r.id === 'deleted-secret')).toMatchObject({
      selected: true,
      orphan: true,
    });
  });

  test("'all' ticks nothing — the checklist is only for a specific grant", () => {
    expect(buildScopeChecklist('all', secrets, 'case-insensitive')).toEqual([
      {
        id: 'GMAPS-primary',
        label: 'GMAPS-primary',
        hint: 'GOOGLE_MAPS_API_KEY',
        selected: false,
        orphan: false,
      },
    ]);
  });
});

describe('toggleScopeSelection', () => {
  test('unticking removes the entry whatever case the manifest used', () => {
    // Removing only the byte-identical id left `gmaps-primary` in the manifest,
    // so the grant stayed live under a checkbox that now read as off.
    expect(toggleScopeSelection(['gmaps-primary'], 'GMAPS-primary', 'case-insensitive')).toEqual(
      [],
    );
  });

  test('unticking clears every case variant of the same grant', () => {
    expect(
      toggleScopeSelection(['gmaps-primary', 'GMAPS-PRIMARY'], 'GMAPS-primary', 'case-insensitive'),
    ).toEqual([]);
  });

  test('ticking appends the option id and keeps the rest', () => {
    expect(toggleScopeSelection(['other'], 'GMAPS-primary', 'case-insensitive')).toEqual([
      'other',
      'GMAPS-primary',
    ]);
  });

  test('exact mode treats a case variant as a different connector', () => {
    expect(toggleScopeSelection(['gmail'], 'GMAIL')).toEqual(['gmail', 'GMAIL']);
  });

  test("ticking from 'all' starts a fresh specific list", () => {
    expect(toggleScopeSelection('all', 'gmail')).toEqual(['gmail']);
  });
});

/**
 * `ScopeEditor` holds `useState`, and `renderToStaticMarkup` cannot run a
 * hook-bearing component in this workspace (the sibling
 * `session-scope-control.test.tsx` fails the same way on an unmodified tree).
 * So the wiring the pure builder cannot cover is asserted against the source.
 */
describe('AgentScopeCard wiring', () => {
  const source = readFileSync(join(import.meta.dir, 'agent-detail-aside.tsx'), 'utf8');

  test('the Secrets checklist comes from the identifier-keyed builder', () => {
    expect(source).toContain('buildSecretScopeOptions(secretsQuery.data?.items ?? [])');
  });

  test('no option list keys a secret grant on `s.name`', () => {
    expect(source).not.toMatch(/secretsQuery\.data[^\n]*\.name/);
    expect(source).not.toContain('map((s) => s.name)');
  });

  test('the checklist row renders the hint', () => {
    expect(source).toContain('{o.hint}');
  });

  test('the Secrets editor asks for the server-matching case rule', () => {
    // Without this prop the Secrets checklist falls back to `match='exact'`,
    // which is the connector rule, not `agentMayUseEnv`.
    expect(source).toMatch(/label="Secrets"[\s\S]{0,320}?match="case-insensitive"/);
  });

  test('the Connectors editor stays on the exact default', () => {
    expect(source).not.toMatch(/label="Connectors"[\s\S]{0,320}?match=/);
  });
});
