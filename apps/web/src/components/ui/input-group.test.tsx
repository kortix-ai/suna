import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from './input-group';

describe('InputGroup', () => {
  test('renders a group container with its slot, role and caller classes', () => {
    const html = renderToStaticMarkup(<InputGroup className="w-64" />);
    expect(html).toContain('data-slot="input-group"');
    expect(html).toContain('role="group"');
    expect(html).toContain('w-64');
  });

  test('marks itself invalid when aria-invalid is set', () => {
    expect(renderToStaticMarkup(<InputGroup aria-invalid />)).toContain('aria-invalid="true"');
  });
});

describe('InputGroupAddon', () => {
  test('defaults to the inline-start alignment', () => {
    const html = renderToStaticMarkup(<InputGroupAddon>icon</InputGroupAddon>);
    expect(html).toContain('data-slot="input-group-addon"');
    expect(html).toContain('data-align="inline-start"');
    expect(html).toContain('icon');
  });

  test('keeps the requested alignment', () => {
    expect(renderToStaticMarkup(<InputGroupAddon align="inline-end">x</InputGroupAddon>)).toContain(
      'data-align="inline-end"',
    );
  });
});

describe('InputGroupButton', () => {
  test('renders a button with the default type and size', () => {
    const html = renderToStaticMarkup(<InputGroupButton>Go</InputGroupButton>);
    expect(html).toContain('type="button"');
    expect(html).toContain('data-size="xs"');
    expect(html).toContain('Go');
  });
});

describe('InputGroupInput', () => {
  test('renders the group control input', () => {
    const html = renderToStaticMarkup(
      <InputGroupInput placeholder="Search projects" />,
    );
    expect(html).toContain('data-slot="input-group-control"');
    expect(html).toContain('placeholder="Search projects"');
  });
});

describe('InputGroupSearch', () => {
  test('renders the search wrapper, icon and control slots', () => {
    const html = renderToStaticMarkup(
      <InputGroupSearch>
        <InputGroupSearchIcon />
        <InputGroupSearchInput />
      </InputGroupSearch>,
    );
    expect(html).toContain('data-slot="input-group-search"');
    expect(html).toContain('data-slot="input-group-search-icon"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-slot="input-group-search-control"');
  });

  test('renders the clear button with its label and slot', () => {
    const html = renderToStaticMarkup(<InputGroupSearchClear />);
    expect(html).toContain('data-slot="input-group-search-clear"');
    expect(html).toContain('aria-label="Clear"');
  });
});
