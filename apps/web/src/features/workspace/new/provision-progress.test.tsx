import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { stripTags } from '@/test-utils/strip-tags';
import { ProvisionProgress } from './provision-progress';
import type { ProvisionPhase } from '@kortix/sdk';

const render = (props: Parameters<typeof ProvisionProgress>[0]) =>
  renderToStaticMarkup(<ProvisionProgress {...props} />);

describe('ProvisionProgress', () => {
  test('announces progress to assistive tech: aria-live polite, aria-busy true', () => {
    const html = render({ workspaceName: 'suna-web', current: null });
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
  });

  test('shows the workspace name being created', () => {
    const html = render({ workspaceName: 'suna-web', current: null });
    expect(stripTags(html)).toContain('Creating suna-web');
  });

  test('renders all four human labels, in server order, never the wire names', () => {
    const html = render({ workspaceName: 'x', current: null });
    const text = stripTags(html);
    const order = [
      'Checking the name',
      'Creating repository',
      'Registering workspace',
      'Adding starter files',
    ];
    let cursor = -1;
    for (const label of order) {
      const at = text.indexOf(label, cursor + 1);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    // Paired negative: the raw wire names never leak into the rendered text.
    const wireNames: ProvisionPhase[] = [
      'validating',
      'creating_repository',
      'registering',
      'seeding',
    ];
    for (const wireName of wireNames) {
      expect(text).not.toContain(wireName);
    }
  });

  test('the active phase gets the Loading spinner, not a checkmark or a dot', () => {
    const html = render({ workspaceName: 'x', current: 'registering' });
    // Loading renders an <svg> with this class, checks render a phosphor
    // CheckIcon <svg>, pending renders a plain <span> dot — counting the
    // orbit-animation class is specific to the ACTIVE state's spinner.
    expect(html.match(/animate-spinner-orbit/g) ?? []).toHaveLength(1);
  });

  test('phases before the current one render a checkmark, not a spinner or a dot', () => {
    const html = render({ workspaceName: 'x', current: 'registering' });
    // validating + creating_repository are done => two checkmarks.
    expect(html.match(/text-kortix-green/g) ?? []).toHaveLength(2);
  });

  test('phases after the current one render a pending dot, not a checkmark or a spinner', () => {
    const html = render({ workspaceName: 'x', current: 'registering' });
    // seeding is the only phase after "registering" => one pending dot.
    expect(html.match(/bg-border size-1\.5 rounded-full/g) ?? []).toHaveLength(1);
  });

  test('nothing is pending once the last phase is active — zero dots', () => {
    const html = render({ workspaceName: 'x', current: 'seeding' });
    expect(html).not.toContain('rounded-full');
  });

  test('before the first event, all four phases render the pending dot', () => {
    const html = render({ workspaceName: 'x', current: null });
    expect(html.match(/bg-border size-1\.5 rounded-full/g) ?? []).toHaveLength(4);
    expect(html).not.toContain('text-kortix-green');
    expect(html.match(/animate-spinner-orbit/g) ?? []).toHaveLength(0);
  });

  test('the panel is the ONE bordered card — no nested card inside it', () => {
    const html = render({ workspaceName: 'x', current: null });
    expect((html.match(/rounded-md border/g) ?? []).length).toBe(1);
  });
});
