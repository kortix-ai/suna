import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CreateApiKeyAction } from './cli-tokens-tab';

describe('CreateApiKeyAction — create must stay reachable once tokens exist (regression: button only lived in the empty state)', () => {
  test('renders the Create API key action when active tokens already exist', () => {
    const html = renderToStaticMarkup(
      <CreateApiKeyAction
        creating={false}
        loading={false}
        error={false}
        tokenCount={6}
        onStartCreate={() => {}}
      />,
    );
    expect(html).toContain('Create API key');
  });

  test('renders nothing while the inline create form is open', () => {
    const html = renderToStaticMarkup(
      <CreateApiKeyAction
        creating
        loading={false}
        error={false}
        tokenCount={6}
        onStartCreate={() => {}}
      />,
    );
    expect(html).toBe('');
  });

  test('renders nothing when there are no tokens — the empty state owns the CTA', () => {
    const html = renderToStaticMarkup(
      <CreateApiKeyAction
        creating={false}
        loading={false}
        error={false}
        tokenCount={0}
        onStartCreate={() => {}}
      />,
    );
    expect(html).toBe('');
  });

  test('renders nothing while tokens are loading or errored', () => {
    const loadingHtml = renderToStaticMarkup(
      <CreateApiKeyAction
        creating={false}
        loading
        error={false}
        tokenCount={0}
        onStartCreate={() => {}}
      />,
    );
    const errorHtml = renderToStaticMarkup(
      <CreateApiKeyAction
        creating={false}
        loading={false}
        error
        tokenCount={0}
        onStartCreate={() => {}}
      />,
    );
    expect(loadingHtml).toBe('');
    expect(errorHtml).toBe('');
  });

  test('clicking the action starts the inline create flow', () => {
    let calls = 0;
    const element = CreateApiKeyAction({
      creating: false,
      loading: false,
      error: false,
      tokenCount: 6,
      onStartCreate: () => {
        calls += 1;
      },
    });
    expect(element).not.toBeNull();
    const button = (element as { props: { children: { props: { onClick: () => void } } } }).props
      .children;
    expect(typeof button.props.onClick).toBe('function');
    button.props.onClick();
    expect(calls).toBe(1);
  });
});
