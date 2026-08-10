import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { easyConnectUnavailableReason } from './connector-connection-form';

/**
 * An app with no actions is listed, and stopped at the point of action.
 *
 * The catalogue used to withhold every Pipedream app with `has_actions: false`
 * — 1,263 of 3,230, 39.1%. That made them unreachable by any query at all,
 * including their own exact name: `q=Auth0` returned zero results because the
 * one Auth0 record is action-less, and `q=SAP` returned 21 of the 30 apps
 * Pipedream itself lists, with both real SAP records missing. Listing them is
 * the fix; saying so at the add step is what stops the fix becoming a dead end.
 */
const SECTIONS = import.meta.dir;

describe('easyConnectUnavailableReason', () => {
  test('an app with no actions cannot be added, and the reason names it', () => {
    const reason = easyConnectUnavailableReason({
      slug: 'sap_s_4hana_cloud',
      name: 'SAP S/4HANA Cloud',
      hasActions: false,
    });
    expect(reason).toContain('SAP S/4HANA Cloud');
    expect(reason).toContain('no actions');
  });

  test('an app with actions is addable', () => {
    expect(
      easyConnectUnavailableReason({ slug: 'github', name: 'GitHub', hasActions: true }),
    ).toBeNull();
  });

  // `hasActions` is optional on `EasyConnectApp` so a hand-typed `{slug, name}`
  // stays valid. Absent must mean addable — treating it as a block would
  // silently disable every non-Pipedream caller.
  test('an app that does not publish the flag is addable', () => {
    expect(easyConnectUnavailableReason({ slug: 'x', name: 'X' })).toBeNull();
  });

  test('no app selected is not a block', () => {
    expect(easyConnectUnavailableReason(null)).toBeNull();
  });
});

describe('every Pipedream add surface passes the reason', () => {
  // Three surfaces list the same catalogue and each builds its own modal. One
  // of them forgetting this prop would keep offering the dead end this whole
  // change exists to remove, and nothing else would catch it.
  const SURFACES = [
    [
      'connectors page',
      join(
        SECTIONS,
        '../../capabilities/connectors/add/easy-connect-add-flow.tsx',
      ),
    ],
    ['add-connector modal', join(SECTIONS, 'connectors-view.tsx')],
    [
      'onboarding tools step',
      join(SECTIONS, '../../../../components/workspaces/onboarding/steps/tools-step.tsx'),
    ],
  ] as const;

  for (const [label, path] of SURFACES) {
    test(`${label} passes unavailableReason`, () => {
      expect(readFileSync(path, 'utf8')).toContain(
        'unavailableReason={easyConnectUnavailableReason(',
      );
    });
  }
});

describe('the modal honours the reason', () => {
  const MODAL = readFileSync(join(SECTIONS, 'connector-connection-modal.tsx'), 'utf8');

  // Disabling the button alone is not enough: the form's own submit handler
  // fires on Enter in a text input, which never touches the button.
  test('submit is disabled AND the handler returns early', () => {
    expect(MODAL).toContain('Boolean(unavailableReason)');
    expect(MODAL).toContain('|| unavailableReason) return');
  });

  test('the reason is rendered, not only enforced', () => {
    expect(MODAL).toContain('{unavailableReason}');
  });
});
