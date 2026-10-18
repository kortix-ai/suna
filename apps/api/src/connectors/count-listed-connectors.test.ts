import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { connectors as connectorsTable } from '@kortix/db';

// KRTX-2669: `kortix connectors sync` printed "Synced 2 connectors" while
// `connectors ls` listed exactly 1 — the sync counted every materialized spec,
// including the built-in computer connector the admin listing deliberately
// hides while it has no paired machine (KRTX-1492). The summary must be
// counted by the SAME rules the listing uses, so the two commands cannot
// disagree. `countListedConnectors` is that count: the listing's own hide
// rules over the project's rows.

interface Row {
  connectorId: string;
  slug: string;
  providerType: string;
  createdAt: Date;
}

function row(connectorId: string, slug: string, providerType: string): Row {
  return { connectorId, slug, providerType, createdAt: new Date('2026-01-01T00:00:00Z') };
}

let connectorRows: Row[] = [];
/** connector_connections rows with a bound tunnel — the machines. */
let machineRows: { connectorId: string }[] = [];

const fakeDb: any = {
  select: () => ({
    from: () => ({
      where: async () => connectorRows,
    }),
  }),
  selectDistinct: () => ({
    from: () => ({
      where: async () => machineRows,
    }),
  }),
};

mock.module('../shared/db', () => ({ db: fakeDb }));

const { countListedConnectors } = await import('./db-deps-rows');

beforeEach(() => {
  connectorRows = [];
  machineRows = [];
});

describe('countListedConnectors', () => {
  test('the dogfood case: one declared connector + a machineless computer row count as one', async () => {
    connectorRows = [row('c-mcp', 'dogfood-mcp', 'mcp'), row('c-computer', 'computer', 'computer')];
    machineRows = [];
    expect(await countListedConnectors('project-1')).toBe(1);
  });

  test('a computer with a paired machine is listed and counted', async () => {
    connectorRows = [row('c-mcp', 'dogfood-mcp', 'mcp'), row('c-computer', 'computer', 'computer')];
    machineRows = [{ connectorId: 'c-computer' }];
    expect(await countListedConnectors('project-1')).toBe(2);
  });

  test('a superseded slack row is hidden the same way the listing hides it', async () => {
    // A legacy user-declared `slack` connector (slug `slack`, managed app on
    // the config) is superseded by the reserved channel row and hidden from
    // the listing — the count must hide it too.
    connectorRows = [
      row('c-mcp', 'dogfood-mcp', 'mcp'),
      { ...row('c-slack-legacy', 'slack', 'mcp'), config: { app: 'slack' } } as Row & {
        config?: unknown;
      },
      row('c-slack', 'kortix_slack', 'channel'),
    ];
    machineRows = [];
    expect(await countListedConnectors('project-1')).toBe(2);
  });

  test('a single-connector sync counts just that connector', async () => {
    connectorRows = [row('c-mcp', 'dogfood-mcp', 'mcp'), row('c-other', 'other', 'http')];
    machineRows = [];
    expect(await countListedConnectors('project-1', 'c-mcp')).toBe(1);
    expect(await countListedConnectors('project-1', 'c-other')).toBe(1);
  });

  test('an empty project counts zero', async () => {
    connectorRows = [];
    machineRows = [];
    expect(await countListedConnectors('project-1')).toBe(0);
  });

  test('the queried table is the project connectors table', async () => {
    // Guard against the fake lying: the real function reads the connectors
    // table (not connectorActions or connections) for the listing rows.
    let selectedFrom: unknown[] = [];
    const probingDb: any = {
      select: () => ({
        from: (table: unknown) => {
          selectedFrom.push(table);
          return { where: async () => [] };
        },
      }),
      selectDistinct: () => ({
        from: () => ({ where: async () => [] }),
      }),
    };
    mock.module('../shared/db', () => ({ db: probingDb }));
    const mod = await import('./db-deps-rows');
    await mod.countListedConnectors('project-1');
    expect(selectedFrom).toContain(connectorsTable);
  });
});
