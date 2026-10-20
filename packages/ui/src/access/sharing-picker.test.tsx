import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { UiProvider } from '../providers/ui-provider';
import { SharingPicker } from './sharing-picker';

const render = (accountApiEnabled?: boolean) =>
  renderToStaticMarkup(
    <UiProvider config={accountApiEnabled === undefined ? undefined : { accountApiEnabled }}>
      <SharingPicker
        projectId="project-1"
        value={{ mode: 'project', memberIds: [], groupIds: [] }}
        onChange={() => {}}
      />
    </UiProvider>,
  );

describe('SharingPicker and accountApiEnabled', () => {
  test('offers "Specific people" by default', () => {
    expect(render()).toContain('share-option-members');
  });

  test('a host that blocks the account routes gets no "Specific people" option', () => {
    const html = render(false);
    expect(html).not.toContain('share-option-members');
    expect(html).toContain('share-option-project');
    expect(html).toContain('share-option-private');
  });
});
