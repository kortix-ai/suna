import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { classifyLandingTerminal, ProjectStartEmpty } from './landing-terminal';

describe('classifyLandingTerminal', () => {
  test('a member without PROJECT_CREATE is no-permission, suppression or not', () => {
    expect(classifyLandingTerminal({ canCreate: false, suppressed: false })).toBe(
      'no-permission',
    );
    expect(classifyLandingTerminal({ canCreate: false, suppressed: true })).toBe(
      'no-permission',
    );
  });

  test('an owner/admin who just archived their last workspace is suppressed', () => {
    expect(classifyLandingTerminal({ canCreate: true, suppressed: true })).toBe('suppressed');
  });

  test('an owner/admin blocked only by the navigation-intent gate is blocked', () => {
    expect(classifyLandingTerminal({ canCreate: true, suppressed: false })).toBe('blocked');
  });
});

function renderEmpty(reason: ReturnType<typeof classifyLandingTerminal>) {
  return renderToStaticMarkup(createElement(ProjectStartEmpty, { reason }));
}

/**
 * `/projects` is a redirect back to `../page.tsx` (Task 21) — this component
 * is THE fix for the infinite `/projects/start` <-> `/projects` loop that
 * created, so every case renders a real surface (not another redirect) and
 * only offers a link that resolves somewhere other than `/projects`.
 */
describe('ProjectStartEmpty', () => {
  test('suppressed: renders a surface, names the archive, links to /new', () => {
    const html = renderEmpty('suppressed');

    expect(html).toContain('Your last workspace is archived');
    expect(html).toContain('href="/new"');
    expect(html).not.toContain('href="/projects"');
  });

  test('no-permission: renders a surface, offers no create control', () => {
    const html = renderEmpty('no-permission');

    expect(html).toContain('No workspace yet');
    expect(html).toContain('owner or admin');
    // No button at all in this case — not just "no /new button" but no <a>/
    // <button> whose click could 403, matching the brief's "a create control
    // that only 403s is worse than none".
    expect(html).not.toContain('<a');
    expect(html).not.toContain('<button');
  });

  test('blocked: renders a surface, links to /new, does not claim an archive happened', () => {
    const html = renderEmpty('blocked');

    expect(html).toContain('No workspace open');
    expect(html).toContain('href="/new"');
    expect(html).not.toContain('archived');
  });

  test('none of the three cases ever link back to /projects', () => {
    for (const reason of ['suppressed', 'no-permission', 'blocked'] as const) {
      expect(renderEmpty(reason)).not.toContain('/projects');
    }
  });
});
