import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * "In this project" — the strip above All-tab search results that points
 * back at connectors the project already has. It exists so a search that
 * would otherwise only surface catalogue apps also surfaces what is already
 * connected, without becoming a second tab: it is gated on an active,
 * matching search and capped at 4 cards.
 *
 * It renders the SAME card the Connected tab renders — `ConnectedConnectorCard`
 * — so the two lists can never describe one connector two different ways.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'connectors-page.tsx'), 'utf8');

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

// The catalogActive branch renders the strip, then `ConnectorBrowse`. The
// next `<CatalogGrid` in source order belongs to the Connected branch (the
// `else` of the same ternary chain), so it is a safe end marker.
const catalogActiveSlice = (body: string) => {
  const start = body.indexOf('catalogActive ? (');
  expect(start).toBeGreaterThan(-1);
  const end = body.indexOf('<CatalogGrid', start);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
};

// The Connected tab's grid: from its `<CatalogGrid` through the shell it sits
// in closing.
const connectedGridSlice = (body: string) => {
  const start = body.indexOf('<CatalogGrid');
  expect(start).toBeGreaterThan(-1);
  const end = body.indexOf('</CapabilityPageShell>', start);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
};

describe('connectors page "In this project" strip', () => {
  test('the strip lives inside the catalogActive branch, gated on an active search that matches', () => {
    const slice = catalogActiveSlice(code(source));
    expect(slice).toContain('query.trim().length > 0 && filtered.length > 0');
    expect(slice).toContain('aria-labelledby="project-matches-title"');
    expect(slice).toContain('In this project');
  });

  test('the strip renders ConnectedConnectorCard', () => {
    const slice = catalogActiveSlice(code(source));
    expect(slice).toContain('<ConnectedConnectorCard');
  });

  test('the strip is capped at 4 cards — a pointer, not a second tab', () => {
    const slice = catalogActiveSlice(code(source));
    expect(slice).toContain('filtered.slice(0, 4)');
  });

  test('the Connected grid renders the same ConnectedConnectorCard — one card source', () => {
    const grid = connectedGridSlice(code(source));
    expect(grid).toContain('{filtered.map((connector) => (');
    expect(grid).toContain('<ConnectedConnectorCard');
    // Not a second, independently-hand-rolled copy of the card markup.
    expect(grid).not.toContain('<CatalogCard');
  });

  test('the strip never renders on the Connected or Channels tabs', () => {
    const body = code(source);
    const channelsStart = body.indexOf('{channelsActive ? (');
    const catalogStart = body.indexOf('catalogActive ? (');
    expect(channelsStart).toBeGreaterThan(-1);
    expect(catalogStart).toBeGreaterThan(channelsStart);

    // Channels branch (between the two markers) never mentions the strip.
    expect(body.slice(channelsStart, catalogStart)).not.toContain('project-matches-title');
    // Connected grid branch never mentions the strip either.
    expect(connectedGridSlice(body)).not.toContain('project-matches-title');
  });
});
