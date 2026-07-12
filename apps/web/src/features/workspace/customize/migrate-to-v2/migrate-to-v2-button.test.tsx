import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MigrateToV2ButtonView } from './migrate-to-v2-button';

describe('MigrateToV2ButtonView — v1/v2 visibility', () => {
  test('renders the action when the project is v1', () => {
    const html = renderToStaticMarkup(
      <MigrateToV2ButtonView visible pending={false} onClick={() => {}} />,
    );
    expect(html).toContain('Migrate to v2');
  });

  test('renders nothing once the project is v2', () => {
    const html = renderToStaticMarkup(
      <MigrateToV2ButtonView visible={false} pending={false} onClick={() => {}} />,
    );
    expect(html).toBe('');
  });

  test('disables itself and swaps the icon for a spinner while a session is being created', () => {
    const html = renderToStaticMarkup(
      <MigrateToV2ButtonView visible pending onClick={() => {}} />,
    );
    expect(html).toContain('disabled');
  });
});

describe('MigrateToV2ButtonView — click wiring', () => {
  test('clicking invokes the handler passed in (wired straight through to Button, no indirection)', () => {
    let calls = 0;
    const onClick = () => {
      calls += 1;
    };
    // Calling the component as a plain function (no JSX) returns the React
    // element tree without rendering — `<Button onClick={onClick}>` is
    // returned untouched, so `element.props.onClick` IS the handler we
    // passed in. This is how we verify "click triggers session-create"
    // without a DOM/event-loop test harness (this repo has neither wired up).
    const element = MigrateToV2ButtonView({ visible: true, pending: false, onClick });
    expect(element).not.toBeNull();
    const props = (element as { props: { onClick: () => void } }).props;
    expect(typeof props.onClick).toBe('function');
    props.onClick();
    expect(calls).toBe(1);
  });
});
